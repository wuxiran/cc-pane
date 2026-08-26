//! Business rules for media canvas persistence and provider-job lifecycle.
//!
//! This service intentionally does not perform provider HTTP. It gives Tauri,
//! Web and MCP callers one durable, validated API; an application-layer worker
//! can claim queued runs and call `transition_run` as provider work progresses.

use crate::models::{
    CreateMediaAssetRequest, CreateMediaEdgeRequest, CreateMediaNodeRequest, CreateMediaRunRequest,
    MediaAsset, MediaEdge, MediaEdgeSelector, MediaKind, MediaNode, MediaOperation,
    MediaProviderOutput, MediaProviderRef, MediaQueueSnapshot, MediaRun, MediaRunStatus,
    ReplayMediaRunRequest, StageMediaInputRequest, UpdateMediaNodeRequest, UpdateMediaRunRequest,
};
use crate::repository::{MediaCacheHit, MediaRepository};
use crate::services::media_probe::{MediaProbe, MediaProbeReport};
use crate::services::WorkspaceService;
use crate::utils::error::{AppError, AppResult};
use base64::Engine;
use chrono::Utc;
use parking_lot::RwLock;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_TITLE_BYTES: usize = 256;
const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_ASSET_BYTES: i64 = 512 * 1024 * 1024;
const MAX_LEASE_OWNER_BYTES: usize = 128;
const MEDIA_PRIORITY_MIN: i32 = -100;
const MEDIA_PRIORITY_MAX: i32 = 100;
const EXECUTION_FINGERPRINT_VERSION: &str = "media-execution-v3";
const MEDIA_SCOPE_KEY: &str = "mediaScope";
const MEDIA_STORAGE_KEY: &str = "mediaStorage";
const PROJECT_MEDIA_DIRECTORY: &[&str] = &[".ccpanes", "media"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct MediaScope {
    workspace_id: String,
    project_id: String,
    /// Display-only value supplied by the client. Filesystem access always
    /// uses the path resolved from `WorkspaceService`.
    project_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaStorageKind {
    Project,
    Application,
}

pub struct MediaService {
    repo: Arc<MediaRepository>,
    media_root: Option<PathBuf>,
    media_probe: MediaProbe,
    workspace_service: RwLock<Option<Arc<WorkspaceService>>>,
}

impl MediaService {
    pub fn new(repo: Arc<MediaRepository>) -> Self {
        Self {
            repo,
            media_root: None,
            media_probe: MediaProbe::from_environment(),
            workspace_service: RwLock::new(None),
        }
    }

    /// Construct a service that can resolve persisted assets for desktop/Web
    /// media previews. Tests and callers that only need metadata can keep using
    /// `new`, which intentionally has no filesystem authority.
    pub fn with_media_root(repo: Arc<MediaRepository>, media_root: PathBuf) -> Self {
        Self {
            repo,
            media_root: Some(media_root),
            media_probe: MediaProbe::from_environment(),
            workspace_service: RwLock::new(None),
        }
    }

    /// Attach the workspace registry used to resolve project-scoped media
    /// roots. Keeping this optional preserves metadata-only test/import
    /// callers; desktop and web production surfaces always inject it.
    pub fn set_workspace_service(&self, service: Arc<WorkspaceService>) {
        *self.workspace_service.write() = Some(service);
    }

    /// Read a media scope from a request/parameter object and validate its
    /// workspace ownership. The optional client path is retained only for
    /// display and migration; it is never used for filesystem access.
    fn media_scope_from_value(
        &self,
        expected_workspace_id: &str,
        value: &serde_json::Value,
    ) -> AppResult<Option<MediaScope>> {
        let Some(scope_value) = value
            .get(MEDIA_SCOPE_KEY)
            .or_else(|| value.get("media_scope"))
        else {
            return Ok(None);
        };
        let object = scope_value.as_object().ok_or_else(|| {
            AppError::coded("MEDIA_SCOPE_INVALID", "mediaScope must be a JSON object")
        })?;
        let workspace_id = object
            .get("workspaceId")
            .or_else(|| object.get("workspace_id"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::coded("MEDIA_SCOPE_INVALID", "mediaScope.workspaceId is required")
            })?
            .to_string();
        let project_id = object
            .get("projectId")
            .or_else(|| object.get("project_id"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AppError::coded("MEDIA_SCOPE_INVALID", "mediaScope.projectId is required")
            })?
            .to_string();
        validate_id(&workspace_id, "workspaceId")?;
        validate_id(&project_id, "projectId")?;
        if workspace_id != expected_workspace_id {
            return Err(AppError::coded(
                "MEDIA_WORKSPACE_MISMATCH",
                "media scope belongs to another workspace",
            ));
        }
        let project_path = object
            .get("projectPath")
            .or_else(|| object.get("project_path"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if project_path
            .as_deref()
            .is_some_and(|path| path.len() > 4096 || path.chars().any(char::is_control))
        {
            return Err(AppError::coded(
                "MEDIA_SCOPE_INVALID",
                "mediaScope.projectPath is invalid",
            ));
        }
        self.ensure_registered_project(&workspace_id, &project_id)?;
        Ok(Some(MediaScope {
            workspace_id,
            project_id,
            project_path,
        }))
    }

    fn ensure_registered_project(&self, workspace_id: &str, project_id: &str) -> AppResult<()> {
        let Some(service) = self.workspace_service.read().clone() else {
            // Metadata-only callers do not have authority to resolve a local
            // path. They can still persist a scope and will use app storage.
            return Ok(());
        };
        match service
            .find_project(workspace_id, project_id)
            .map_err(AppError::from)?
        {
            Some(_) => Ok(()),
            None => Err(AppError::coded(
                "MEDIA_PROJECT_NOT_FOUND",
                "media project is not registered in the workspace",
            )),
        }
    }

    fn project_media_root(&self, scope: &MediaScope) -> AppResult<Option<PathBuf>> {
        let Some(service) = self.workspace_service.read().clone() else {
            return Ok(None);
        };
        let Some(project) = service
            .find_project(&scope.workspace_id, &scope.project_id)
            .map_err(AppError::from)?
        else {
            return Err(AppError::coded(
                "MEDIA_PROJECT_NOT_FOUND",
                "media project is not registered in the workspace",
            ));
        };
        // SSH projects and non-local WSL paths cannot be addressed by the
        // desktop process. They remain valid metadata scopes and fall back to
        // application storage until a remote media transport exists.
        if project.ssh.is_some()
            || project.path.starts_with("ssh://")
            || project.path.trim().is_empty()
        {
            return Ok(None);
        }
        let project_path = Path::new(&project.path);
        if !project_path.is_absolute() || !project_path.is_dir() {
            return Ok(None);
        }
        let project_root = dunce::canonicalize(project_path).map_err(|error| {
            AppError::coded("MEDIA_PROJECT_PATH_UNAVAILABLE", error.to_string())
        })?;
        let storage = PROJECT_MEDIA_DIRECTORY
            .iter()
            .fold(project_root.clone(), |path, component| path.join(component));
        std::fs::create_dir_all(&storage).map_err(|error| {
            AppError::coded("MEDIA_PROJECT_PATH_UNAVAILABLE", error.to_string())
        })?;
        let storage = dunce::canonicalize(&storage).map_err(|error| {
            AppError::coded("MEDIA_PROJECT_PATH_UNAVAILABLE", error.to_string())
        })?;
        if !storage.starts_with(&project_root) {
            return Err(AppError::coded(
                "MEDIA_PATH_INVALID",
                "project media directory escapes the project root",
            ));
        }
        Ok(Some(storage))
    }

    fn application_media_root(&self) -> AppResult<PathBuf> {
        let configured_root = self.media_root.as_ref().ok_or_else(|| {
            AppError::coded(
                "MEDIA_ASSET_PATH_UNAVAILABLE",
                "media asset storage is unavailable",
            )
        })?;
        std::fs::create_dir_all(configured_root)?;
        dunce::canonicalize(configured_root)
            .map_err(|error| AppError::coded("MEDIA_ASSET_PATH_UNAVAILABLE", error.to_string()))
    }

    fn storage_root_for_scope(
        &self,
        scope: Option<&MediaScope>,
    ) -> AppResult<(PathBuf, MediaStorageKind)> {
        if let Some(scope) = scope {
            if let Some(root) = self.project_media_root(scope)? {
                return Ok((root, MediaStorageKind::Project));
            }
        }
        Ok((
            self.application_media_root()?,
            MediaStorageKind::Application,
        ))
    }

    fn relative_asset_path(
        workspace_id: &str,
        scope: Option<&MediaScope>,
        asset_id: &str,
        extension: &str,
    ) -> String {
        let extension = extension.trim_start_matches('.');
        match scope {
            Some(scope) => format!(
                "{}/{}/{}.{}",
                workspace_id, scope.project_id, asset_id, extension
            ),
            None => format!("{}/{}.{}", workspace_id, asset_id, extension),
        }
    }

    fn scope_value(scope: &MediaScope) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        object.insert(
            "workspaceId".to_string(),
            serde_json::Value::String(scope.workspace_id.clone()),
        );
        object.insert(
            "projectId".to_string(),
            serde_json::Value::String(scope.project_id.clone()),
        );
        if let Some(path) = scope.project_path.as_deref() {
            object.insert(
                "projectPath".to_string(),
                serde_json::Value::String(path.to_string()),
            );
        }
        serde_json::Value::Object(object)
    }

    fn scope_metadata(
        scope: Option<&MediaScope>,
        storage_kind: MediaStorageKind,
    ) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        if let Some(scope) = scope {
            object.insert(MEDIA_SCOPE_KEY.to_string(), Self::scope_value(scope));
        }
        object.insert(
            MEDIA_STORAGE_KEY.to_string(),
            serde_json::Value::String(
                match storage_kind {
                    MediaStorageKind::Project => "project",
                    MediaStorageKind::Application => "application",
                }
                .to_string(),
            ),
        );
        serde_json::Value::Object(object)
    }

    fn merge_scope_metadata(
        metadata: &mut serde_json::Value,
        scope: Option<&MediaScope>,
        storage_kind: MediaStorageKind,
    ) {
        let Some(object) = metadata.as_object_mut() else {
            *metadata = serde_json::json!({});
            return Self::merge_scope_metadata(metadata, scope, storage_kind);
        };
        if let serde_json::Value::Object(scope_metadata) = Self::scope_metadata(scope, storage_kind)
        {
            for (key, value) in scope_metadata {
                object.insert(key, value);
            }
        }
    }

    fn scope_from_request(
        &self,
        workspace_id: &str,
        request: &serde_json::Value,
    ) -> AppResult<Option<MediaScope>> {
        if let Some(parameters) = request.get("parameters") {
            if let Some(scope) = self.media_scope_from_value(workspace_id, parameters)? {
                return Ok(Some(scope));
            }
        }
        self.media_scope_from_value(workspace_id, request)
    }

    /// Replace the optional video probe for a desktop installation or a
    /// deterministic test fixture. The probe never receives provider URLs or
    /// user paths; it only sees files already inside the controlled media root.
    pub fn with_media_probe(mut self, media_probe: MediaProbe) -> Self {
        self.media_probe = media_probe;
        self
    }

    /// Resolve an asset to a regular file below the configured media root.
    /// Canonicalization rejects symlink escapes as well as `..` traversal. A
    /// project-scoped asset is resolved below `<project>/.ccpanes/media`; old
    /// app-scoped assets continue to resolve below the application media root.
    pub fn resolve_asset_path(&self, asset_id: &str) -> AppResult<PathBuf> {
        validate_id(asset_id, "assetId")?;
        let asset = self
            .get_asset(asset_id)?
            .ok_or_else(|| AppError::coded("MEDIA_ASSET_NOT_FOUND", "media asset not found"))?;
        let candidates = self.asset_path_candidates(&asset)?;
        for candidate in candidates {
            if !candidate.is_file() {
                continue;
            }
            self.verify_asset_file(&candidate, &asset)?;
            return Ok(candidate);
        }
        Err(AppError::coded(
            "MEDIA_ASSET_NOT_FOUND",
            "media asset file was not found",
        ))
    }

    fn asset_path_candidates(&self, asset: &MediaAsset) -> AppResult<Vec<PathBuf>> {
        validate_relative_media_path(&asset.relative_path)?;
        validate_asset_path_for_workspace(&asset.relative_path, &asset.workspace_id)?;
        let scope = self.media_scope_from_value(&asset.workspace_id, &asset.metadata)?;
        let mut roots = Vec::new();
        let storage = asset
            .metadata
            .get(MEDIA_STORAGE_KEY)
            .and_then(serde_json::Value::as_str);
        if storage != Some("application") {
            if let Some(scope) = scope.as_ref() {
                if let Some(root) = self.project_media_root(scope)? {
                    roots.push(root);
                }
            }
        }
        if storage != Some("project") {
            roots.push(self.application_media_root()?);
        }
        let mut candidates = Vec::new();
        for root in roots {
            let candidate = dunce::canonicalize(root.join(Path::new(&asset.relative_path)))
                .map_err(|error| {
                    // A missing candidate is expected when trying the
                    // fallback root; retain it as a non-existent path.
                    if error.kind() == std::io::ErrorKind::NotFound {
                        AppError::coded("MEDIA_ASSET_NOT_FOUND", error.to_string())
                    } else {
                        AppError::coded("MEDIA_ASSET_PATH_INVALID", error.to_string())
                    }
                });
            match candidate {
                Ok(candidate) if candidate.starts_with(&root) => candidates.push(candidate),
                Ok(_) => {
                    return Err(AppError::coded(
                        "MEDIA_ASSET_PATH_INVALID",
                        "media asset path escapes its storage root",
                    ));
                }
                Err(_) => {
                    // The file may be absent in this root; the caller will
                    // report a stable not-found error after trying others.
                }
            }
        }
        Ok(candidates)
    }

    fn verify_asset_file(&self, candidate: &Path, asset: &MediaAsset) -> AppResult<()> {
        let metadata = std::fs::metadata(candidate)?;
        if metadata.len() != asset.size_bytes as u64 {
            return Err(AppError::coded(
                "MEDIA_ASSET_SIZE_MISMATCH",
                "media asset size differs from its persisted metadata",
            ));
        }
        if let Some(expected_hash) = asset.sha256.as_deref() {
            if !is_sha256(expected_hash) {
                return Err(AppError::coded(
                    "MEDIA_HASH_INVALID",
                    "media asset hash metadata is invalid",
                ));
            }
            let bytes = std::fs::read(candidate)?;
            let mut digest = Sha256::new();
            digest.update(bytes);
            if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected_hash) {
                return Err(AppError::coded(
                    "MEDIA_HASH_MISMATCH",
                    "media asset hash differs from its persisted metadata",
                ));
            }
        }
        Ok(())
    }

    pub fn create_node(&self, req: CreateMediaNodeRequest) -> AppResult<MediaNode> {
        validate_scope(&req.workspace_id, &req.layout_id)?;
        let title = clean_title(&req.title)?;
        let operation = req
            .default_operation
            .unwrap_or_else(|| default_operation(req.kind));
        validate_operation_kind(req.kind, operation)?;
        let default_parameters = serde_json::Value::Object(serde_json::Map::new());
        let parameters = req.parameters.as_ref().unwrap_or(&default_parameters);
        validate_parameters(parameters)?;
        let parameters = if parameters.is_null() {
            serde_json::json!({})
        } else {
            parameters.clone()
        };
        // A scoped node is the durable anchor for both image and video modes.
        // The project path is resolved later from the injected workspace
        // registry; this validation only accepts the stable ID pair.
        self.media_scope_from_value(&req.workspace_id, &parameters)?;
        validate_provider_ref(req.provider_ref.as_ref())?;
        let now = now();
        let node = MediaNode {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: req.workspace_id,
            layout_id: req.layout_id,
            kind: req.kind,
            title,
            default_operation: operation,
            provider_ref: req.provider_ref,
            parameters,
            deleted_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        self.repo.insert_node(&node).map_err(AppError::from)?;
        Ok(node)
    }

    pub fn get_node(&self, id: &str) -> AppResult<Option<MediaNode>> {
        validate_id(id, "nodeId")?;
        self.repo.get_node(id).map_err(AppError::from)
    }

    pub fn list_nodes(
        &self,
        workspace_id: &str,
        layout_id: Option<&str>,
        include_deleted: bool,
    ) -> AppResult<Vec<MediaNode>> {
        validate_scope(workspace_id, layout_id.unwrap_or("layout"))?;
        if let Some(layout_id) = layout_id {
            validate_id(layout_id, "layoutId")?;
        }
        self.repo
            .list_nodes(workspace_id, layout_id, include_deleted)
            .map_err(AppError::from)
    }

    pub fn update_node(&self, id: &str, req: UpdateMediaNodeRequest) -> AppResult<MediaNode> {
        validate_id(id, "nodeId")?;
        let existing_node = self
            .repo
            .get_node(id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
        if let Some(title) = &req.title {
            clean_title(title)?;
        }
        if let Some(operation) = req.default_operation {
            validate_operation_kind(existing_node.kind, operation)?;
        }
        if let Some(parameters) = &req.parameters {
            validate_parameters(parameters)?;
            self.media_scope_from_value(&existing_node.workspace_id, parameters)?;
        }
        validate_provider_ref(req.provider_ref.as_ref())?;
        let changed = self
            .repo
            .update_node(id, &req, &now())
            .map_err(AppError::from)?;
        if !changed {
            return Err(AppError::coded(
                "MEDIA_NODE_NOT_FOUND",
                "media node not found",
            ));
        }
        self.get_node(id)?.ok_or_else(|| {
            AppError::coded(
                "MEDIA_NODE_NOT_FOUND",
                "media node disappeared after update",
            )
        })
    }

    pub fn delete_node(&self, id: &str) -> AppResult<bool> {
        validate_id(id, "nodeId")?;
        self.repo
            .soft_delete_node(id, &now())
            .map_err(AppError::from)
    }

    pub fn create_run(&self, req: CreateMediaRunRequest) -> AppResult<MediaRun> {
        self.create_run_with_provider_config_fingerprint(req, None)
    }

    /// Create a run with a caller-derived, non-secret Provider configuration
    /// fingerprint. API surfaces calculate this from the live ProviderService
    /// snapshot so endpoint or protocol changes cannot reuse old outputs.
    pub fn create_run_with_provider_config_fingerprint(
        &self,
        req: CreateMediaRunRequest,
        provider_config_fingerprint: Option<&str>,
    ) -> AppResult<MediaRun> {
        let mut req = req;
        validate_id(&req.node_id, "nodeId")?;
        validate_json(&req.request)?;
        validate_client_request_id(req.client_request_id.as_deref())?;
        validate_provider_config_fingerprint(provider_config_fingerprint)?;
        let priority = req.priority.unwrap_or(0);
        validate_priority(priority)?;
        let cache_policy = req.cache_policy.unwrap_or_default();
        let node = self
            .repo
            .get_node(&req.node_id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
        if node.deleted_at.is_some() {
            return Err(AppError::coded(
                "MEDIA_NODE_DELETED",
                "media node is deleted",
            ));
        }
        let node_scope = self.media_scope_from_value(&node.workspace_id, &node.parameters)?;
        let request_scope = self.scope_from_request(&node.workspace_id, &req.request)?;
        if let (Some(node_scope), Some(request_scope)) = (&node_scope, &request_scope) {
            if node_scope.workspace_id != request_scope.workspace_id
                || node_scope.project_id != request_scope.project_id
            {
                return Err(AppError::coded(
                    "MEDIA_PROJECT_MISMATCH",
                    "media node and run belong to different projects",
                ));
            }
        } else if let (Some(node_scope), None) = (node_scope.as_ref(), request_scope.as_ref()) {
            // Persist the node scope into legacy-shaped requests so replay,
            // worker recovery and output storage retain the same project
            // binding even when an older client omitted it.
            let object = req.request.as_object_mut().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_SCOPE_INVALID",
                    "a scoped media run request must be a JSON object",
                )
            })?;
            let parameters = object
                .entry("parameters".to_string())
                .or_insert_with(|| serde_json::json!({}));
            let parameters = parameters.as_object_mut().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_PARAMETERS_INVALID",
                    "media parameters must be a JSON object",
                )
            })?;
            parameters.insert(MEDIA_SCOPE_KEY.to_string(), Self::scope_value(node_scope));
        }
        validate_generation_parameters(&req.request)?;
        validate_operation_kind(node.kind, req.operation)?;
        if req.operation.requires_input_asset() && req.input_asset_ids.is_empty() {
            return Err(AppError::coded(
                "MEDIA_INPUT_REQUIRED",
                "this media operation requires at least one input asset",
            ));
        }
        if input_kind(node.kind, req.operation).is_none() && !req.input_asset_ids.is_empty() {
            return Err(AppError::coded(
                "MEDIA_INPUT_UNEXPECTED",
                "this media operation does not accept input assets",
            ));
        }
        let mut seen_inputs = std::collections::HashSet::new();
        let mut input_assets = Vec::with_capacity(req.input_asset_ids.len());
        let expected_input_kind = input_kind(node.kind, req.operation);
        for asset_id in &req.input_asset_ids {
            validate_id(asset_id, "assetId")?;
            if !seen_inputs.insert(asset_id) {
                return Err(AppError::coded(
                    "MEDIA_INPUT_DUPLICATE",
                    "an input asset may only be referenced once",
                ));
            }
            let asset = self
                .repo
                .get_asset(asset_id)
                .map_err(AppError::from)?
                .ok_or_else(|| AppError::coded("MEDIA_ASSET_NOT_FOUND", "input asset not found"))?;
            if asset.workspace_id != node.workspace_id {
                return Err(AppError::coded(
                    "MEDIA_WORKSPACE_MISMATCH",
                    "input asset belongs to another workspace",
                ));
            }
            let asset_scope = self.media_scope_from_value(&asset.workspace_id, &asset.metadata)?;
            let effective_scope = request_scope.as_ref().or(node_scope.as_ref());
            if let Some(expected_scope) = effective_scope {
                let Some(asset_scope) = asset_scope else {
                    return Err(AppError::coded(
                        "MEDIA_PROJECT_MISMATCH",
                        "input asset has no project scope",
                    ));
                };
                if asset_scope.project_id != expected_scope.project_id {
                    return Err(AppError::coded(
                        "MEDIA_PROJECT_MISMATCH",
                        "input asset belongs to another project",
                    ));
                }
            }
            if !mime_matches_kind(&asset.mime_type, expected_input_kind) {
                return Err(AppError::coded(
                    "MEDIA_INPUT_KIND_MISMATCH",
                    "input asset type does not match the media operation",
                ));
            }
            validate_asset_path_for_workspace(&asset.relative_path, &node.workspace_id)?;
            input_assets.push(asset);
        }
        validate_input_role_parameters(&req.request, &input_assets)?;
        let execution_fingerprint = execution_fingerprint_with_provider_config(
            &node,
            &req,
            &input_assets,
            provider_config_fingerprint,
        )?;
        if let Some(client_request_id) = req.client_request_id.as_deref() {
            if let Some(existing) = self
                .repo
                .find_run_by_client_request_id(client_request_id)
                .map_err(AppError::from)?
            {
                if existing.node_id != req.node_id
                    || existing.operation != req.operation
                    || existing.request != req.request
                    || existing.input_asset_ids != req.input_asset_ids
                    || existing.provider_ref != node.provider_ref
                    || existing.priority != priority
                    || existing.cache_policy != cache_policy
                    || existing.execution_fingerprint.as_deref()
                        != Some(execution_fingerprint.as_str())
                {
                    return Err(AppError::coded(
                        "MEDIA_IDEMPOTENCY_CONFLICT",
                        "client request id was already used with a different request",
                    ));
                }
                return Ok(existing);
            }
        }
        let cached_output_asset_ids = if cache_policy.allows_lookup() {
            self.cached_output_asset_ids(&node, &execution_fingerprint)?
        } else {
            None
        };
        let cache_hit = cached_output_asset_ids.is_some();
        let now = now();
        let run = MediaRun {
            id: uuid::Uuid::new_v4().to_string(),
            node_id: req.node_id,
            operation: req.operation,
            status: if cache_hit {
                MediaRunStatus::Succeeded
            } else {
                MediaRunStatus::Queued
            },
            attempt: 1,
            priority,
            cache_policy,
            client_request_id: req.client_request_id,
            provider_ref: node.provider_ref,
            request: req.request,
            remote_job_id: None,
            progress: Some(if cache_hit { 100 } else { 0 }),
            error_code: None,
            error_message: None,
            lease_owner: None,
            lease_expires_at: None,
            input_asset_ids: req.input_asset_ids,
            execution_fingerprint: Some(execution_fingerprint),
            cache_hit,
            output_asset_ids: cached_output_asset_ids.unwrap_or_default(),
            created_at: now.clone(),
            updated_at: now,
        };
        if let Err(error) = self.repo.insert_run(&run) {
            // A concurrent duplicate idempotency submission is still a success
            // from the caller's perspective; return the durable winner.
            if let Some(key) = run.client_request_id.as_deref() {
                if let Ok(Some(existing)) = self.repo.find_run_by_client_request_id(key) {
                    return Ok(existing);
                }
            }
            return Err(AppError::from(error));
        }
        if run.cache_hit {
            if let Some(fingerprint) = run.execution_fingerprint.as_deref() {
                let _ =
                    self.repo
                        .touch_cache_entry(&node.workspace_id, fingerprint, &run.updated_at);
            }
        }
        Ok(run)
    }

    /// Re-submit a historical request as a new run.  Overrides are merged at
    /// the provider-parameter object level so a user can change only a seed,
    /// duration, or prompt without losing the original workflow and inputs.
    pub fn replay_run(
        &self,
        source_run_id: &str,
        overrides: ReplayMediaRunRequest,
    ) -> AppResult<MediaRun> {
        self.replay_run_with_provider_config_fingerprint(source_run_id, overrides, None)
    }

    /// Replay a run while binding cache identity to the Provider configuration
    /// that will execute the new variant. The source run stays immutable.
    pub fn replay_run_with_provider_config_fingerprint(
        &self,
        source_run_id: &str,
        overrides: ReplayMediaRunRequest,
        provider_config_fingerprint: Option<&str>,
    ) -> AppResult<MediaRun> {
        validate_id(source_run_id, "runId")?;
        let source = self
            .get_run(source_run_id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "source media run not found"))?;
        let mut request = source.request.clone();
        if !request.is_object() {
            request = serde_json::json!({});
        }
        let object = request
            .as_object_mut()
            .expect("replay request is an object");
        if let Some(prompt) = overrides.prompt {
            object.insert("prompt".to_string(), serde_json::Value::String(prompt));
        }
        if let Some(parameters) = overrides.parameters {
            merge_replay_parameters(object, parameters)?;
        }
        // Keep lineage useful to the history UI while excluding this marker
        // from execution_fingerprint (see `execution_fingerprint`).
        object.insert(
            "replayOfRunId".to_string(),
            serde_json::Value::String(source.id.clone()),
        );
        self.create_run_with_provider_config_fingerprint(
            CreateMediaRunRequest {
                node_id: source.node_id,
                operation: source.operation,
                request,
                client_request_id: Some(
                    overrides
                        .client_request_id
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                ),
                input_asset_ids: overrides.input_asset_ids.unwrap_or(source.input_asset_ids),
                priority: overrides.priority.or(Some(source.priority)),
                cache_policy: overrides.cache_policy.or(Some(source.cache_policy)),
            },
            provider_config_fingerprint,
        )
    }

    pub fn get_run(&self, id: &str) -> AppResult<Option<MediaRun>> {
        validate_id(id, "runId")?;
        self.repo.get_run(id).map_err(AppError::from)
    }

    /// Apply a provider websocket update by remote job id. This deliberately
    /// does not perform a terminal transition: ComfyUI history remains the
    /// source of truth for output files and final status, while this method
    /// gives all frontends low-latency progress and diagnostic text.
    pub fn apply_provider_event(
        &self,
        provider_id: &str,
        remote_job_id: &str,
        progress: Option<i32>,
        error_code: Option<&str>,
        error_message: Option<&str>,
    ) -> AppResult<Option<MediaRun>> {
        validate_id(provider_id, "providerId")?;
        validate_id(remote_job_id, "remoteJobId")?;
        validate_progress(progress)?;
        if error_code.is_some_and(|value| value.is_empty() || value.len() > 128) {
            return Err(AppError::coded(
                "MEDIA_EVENT_INVALID",
                "provider event error code is invalid",
            ));
        }
        if error_message.is_some_and(|value| value.len() > 4096) {
            return Err(AppError::coded(
                "MEDIA_EVENT_INVALID",
                "provider event error message is too long",
            ));
        }
        self.repo
            .apply_provider_event(
                Some(provider_id),
                remote_job_id,
                progress,
                error_code,
                error_message,
                &now(),
            )
            .map_err(AppError::from)
    }

    pub fn list_runs(&self, node_id: &str, limit: u32, offset: u32) -> AppResult<Vec<MediaRun>> {
        validate_id(node_id, "nodeId")?;
        let limit = limit.clamp(1, 200);
        self.repo
            .list_runs(node_id, limit, offset)
            .map_err(AppError::from)
    }

    pub fn recoverable_runs(&self) -> AppResult<Vec<MediaRun>> {
        self.repo.list_recoverable_runs().map_err(AppError::from)
    }

    pub fn queue_snapshot(&self) -> AppResult<MediaQueueSnapshot> {
        self.repo.queue_snapshot().map_err(AppError::from)
    }

    /// Register a successful run as the newest cache source. Cache failures are
    /// surfaced to callers so the scheduler can report storage problems, while
    /// the worker treats them as non-fatal to the already completed run.
    pub fn register_cache(&self, run: &MediaRun) -> AppResult<()> {
        if run.status != MediaRunStatus::Succeeded
            || run.cache_hit
            || !run.cache_policy.allows_write()
            || run.output_asset_ids.is_empty()
        {
            return Ok(());
        }
        let fingerprint = run.execution_fingerprint.as_deref().ok_or_else(|| {
            AppError::coded(
                "MEDIA_FINGERPRINT_MISSING",
                "successful media run has no execution fingerprint",
            )
        })?;
        let node = self
            .get_node(&run.node_id)?
            .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
        self.repo
            .register_cache_entry(&node.workspace_id, fingerprint, &run.id, &now())
            .map_err(AppError::from)
    }

    pub fn set_priority(&self, id: &str, priority: i32) -> AppResult<MediaRun> {
        validate_id(id, "runId")?;
        validate_priority(priority)?;
        let run = self
            .get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if run.status != MediaRunStatus::Queued {
            return Err(AppError::coded(
                "MEDIA_PRIORITY_NOT_ALLOWED",
                "only queued media runs can change priority",
            ));
        }
        let changed = self
            .repo
            .update_run(
                id,
                &UpdateMediaRunRequest {
                    priority: Some(priority),
                    ..Default::default()
                },
                &now(),
            )
            .map_err(AppError::from)?;
        if !changed {
            return Err(AppError::coded(
                "MEDIA_PRIORITY_CONFLICT",
                "media run changed before priority could be updated",
            ));
        }
        self.get_run(id)?.ok_or_else(|| {
            AppError::coded(
                "MEDIA_RUN_NOT_FOUND",
                "media run disappeared after priority update",
            )
        })
    }

    fn cached_output_asset_ids(
        &self,
        node: &MediaNode,
        execution_fingerprint: &str,
    ) -> AppResult<Option<Vec<String>>> {
        let Some(hit) = self
            .repo
            .find_cache_hit(&node.workspace_id, execution_fingerprint)
            .map_err(AppError::from)?
        else {
            return Ok(None);
        };
        match self.validate_cache_hit(node, &hit) {
            Ok(()) => Ok(Some(hit.assets.into_iter().map(|asset| asset.id).collect())),
            Err(_) => {
                // A cache row can outlive an externally removed file. Drop it
                // lazily and let this request execute normally.
                let _ = self
                    .repo
                    .delete_cache_entry(&node.workspace_id, execution_fingerprint);
                Ok(None)
            }
        }
    }

    fn validate_cache_hit(&self, node: &MediaNode, hit: &MediaCacheHit) -> AppResult<()> {
        if hit.assets.is_empty() {
            return Err(AppError::coded(
                "MEDIA_CACHE_EMPTY",
                "cached output is empty",
            ));
        }
        let node_scope = self.media_scope_from_value(&node.workspace_id, &node.parameters)?;
        for asset in &hit.assets {
            if asset.workspace_id != node.workspace_id
                || !mime_matches_kind(&asset.mime_type, Some(node.kind))
            {
                return Err(AppError::coded(
                    "MEDIA_CACHE_INVALID",
                    "cached output does not match the media node",
                ));
            }
            validate_relative_media_path(&asset.relative_path)?;
            validate_asset_path_for_workspace(&asset.relative_path, &node.workspace_id)?;
            if let Some(expected_scope) = node_scope.as_ref() {
                let asset_scope =
                    self.media_scope_from_value(&asset.workspace_id, &asset.metadata)?;
                if asset_scope.as_ref().map(|scope| &scope.project_id)
                    != Some(&expected_scope.project_id)
                {
                    return Err(AppError::coded(
                        "MEDIA_CACHE_INVALID",
                        "cached output belongs to another project",
                    ));
                }
            }
            self.validate_registered_asset_file(asset)?;
        }
        Ok(())
    }

    /// Atomically claim one queued or expired run for a worker.
    pub fn claim_next_run(
        &self,
        owner: &str,
        lease_duration: chrono::Duration,
    ) -> AppResult<Option<MediaRun>> {
        self.claim_next_run_excluding(owner, lease_duration, &[])
    }

    /// Claim a run while excluding ids already reserved by the current batch.
    /// Live remote jobs owned by this worker are still eligible for renewal;
    /// the exclusion prevents a batch from polling one job multiple times.
    pub fn claim_next_run_excluding(
        &self,
        owner: &str,
        lease_duration: chrono::Duration,
        excluded_ids: &[String],
    ) -> AppResult<Option<MediaRun>> {
        if !valid_lease_owner(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_OWNER_INVALID",
                "lease owner cannot be empty",
            ));
        }
        if lease_duration <= chrono::Duration::zero() {
            return Err(AppError::coded(
                "MEDIA_LEASE_DURATION_INVALID",
                "lease duration must be positive",
            ));
        }
        let now = Utc::now();
        let expiry = now + lease_duration;
        self.repo
            .claim_next_run_excluding(owner, &now.to_rfc3339(), &expiry.to_rfc3339(), excluded_ids)
            .map_err(AppError::from)
    }

    pub fn renew_run_lease(
        &self,
        id: &str,
        owner: &str,
        lease_duration: chrono::Duration,
    ) -> AppResult<MediaRun> {
        validate_id(id, "runId")?;
        if !valid_lease_owner(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_OWNER_INVALID",
                "lease owner cannot be empty",
            ));
        }
        if lease_duration <= chrono::Duration::zero() {
            return Err(AppError::coded(
                "MEDIA_LEASE_DURATION_INVALID",
                "lease duration must be positive",
            ));
        }
        let expiry = Utc::now() + lease_duration;
        let changed = self
            .repo
            .renew_run_lease(id, owner, &expiry.to_rfc3339(), &now())
            .map_err(AppError::from)?;
        if !changed {
            return match self.get_run(id)? {
                Some(_) => Err(AppError::coded(
                    "MEDIA_LEASE_LOST",
                    "media run lease is owned by another worker or has expired",
                )),
                None => Err(AppError::coded(
                    "MEDIA_RUN_NOT_FOUND",
                    "media run not found",
                )),
            };
        }
        let run = self.get_run(id)?.ok_or_else(|| {
            AppError::coded(
                "MEDIA_RUN_NOT_FOUND",
                "media run disappeared after lease renewal",
            )
        })?;
        if run.lease_owner.as_deref() != Some(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease is owned by another worker",
            ));
        }
        Ok(run)
    }

    /// Persist the provider job id while retaining the worker lease. This is
    /// the recovery anchor used when the process exits after submission but
    /// before the first poll.
    pub fn record_remote_job(
        &self,
        id: &str,
        owner: &str,
        remote_job_id: &str,
        next_status: MediaRunStatus,
        progress: Option<i32>,
    ) -> AppResult<MediaRun> {
        validate_id(id, "runId")?;
        if !valid_lease_owner(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_OWNER_INVALID",
                "lease owner is invalid",
            ));
        }
        if remote_job_id.trim().is_empty() || remote_job_id.len() > 512 {
            return Err(AppError::coded(
                "MEDIA_REMOTE_JOB_INVALID",
                "provider returned an invalid remote job id",
            ));
        }
        let existing = self
            .get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if existing.lease_owner.as_deref() != Some(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease is owned by another worker",
            ));
        }
        if !lease_is_live(existing.lease_expires_at.as_deref()) {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease has expired",
            ));
        }
        if !existing.status.can_transition_to(next_status) {
            return Err(AppError::coded(
                "MEDIA_INVALID_TRANSITION",
                format!(
                    "cannot transition media run from {} to {}",
                    existing.status, next_status
                ),
            ));
        }
        if let Some(progress) = progress {
            if !(0..=100).contains(&progress) {
                return Err(AppError::coded(
                    "MEDIA_PROGRESS_INVALID",
                    "progress must be 0..100",
                ));
            }
        }
        let changed = self
            .repo
            .update_run_for_owner_from_status(
                id,
                owner,
                &now(),
                existing.status,
                &UpdateMediaRunRequest {
                    status: Some(next_status),
                    remote_job_id: Some(Some(remote_job_id.to_string())),
                    progress: Some(progress),
                    ..Default::default()
                },
                &now(),
            )
            .map_err(AppError::from)?;
        if !changed {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease is no longer owned by this worker",
            ));
        }
        self.get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run disappeared"))
    }

    pub fn clear_run_lease(&self, id: &str, owner: &str) -> AppResult<()> {
        validate_id(id, "runId")?;
        if !valid_lease_owner(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_OWNER_INVALID",
                "lease owner is invalid",
            ));
        }
        let run = self
            .get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if run.lease_owner.as_deref() != Some(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease is owned by another worker",
            ));
        }
        let changed = self
            .repo
            .clear_run_lease(id, owner, &now())
            .map_err(AppError::from)?;
        if !changed {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease is no longer owned by this worker",
            ));
        }
        Ok(())
    }

    pub fn set_remote_job_id(&self, id: &str, remote_job_id: &str) -> AppResult<MediaRun> {
        validate_id(id, "runId")?;
        if remote_job_id.trim().is_empty() || remote_job_id.len() > 512 {
            return Err(AppError::coded(
                "MEDIA_REMOTE_JOB_INVALID",
                "provider returned an invalid remote job id",
            ));
        }
        self.repo
            .update_run(
                id,
                &UpdateMediaRunRequest {
                    remote_job_id: Some(Some(remote_job_id.to_string())),
                    ..Default::default()
                },
                &now(),
            )
            .map_err(AppError::from)?;
        self.get_run(id)?.ok_or_else(|| {
            AppError::coded(
                "MEDIA_RUN_NOT_FOUND",
                "media run disappeared after provider submit",
            )
        })
    }

    pub fn persist_downloaded_asset(
        &self,
        run_id: &str,
        downloaded: &crate::services::media_provider::DownloadedAsset,
    ) -> AppResult<MediaAsset> {
        if downloaded.size_bytes != downloaded.bytes.len() as u64 || !is_sha256(&downloaded.sha256)
        {
            return Err(AppError::coded(
                "MEDIA_DOWNLOAD_METADATA_INVALID",
                "downloaded media metadata does not match its bytes",
            ));
        }
        let mut digest = Sha256::new();
        digest.update(&downloaded.bytes);
        if !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&downloaded.sha256) {
            return Err(AppError::coded(
                "MEDIA_HASH_MISMATCH",
                "downloaded media hash does not match its bytes",
            ));
        }
        let extension = downloaded
            .filename
            .as_deref()
            .and_then(|filename| filename.rsplit('.').next())
            .filter(|extension| is_safe_media_extension(extension));
        let output = MediaProviderOutput {
            bytes: downloaded.bytes.clone(),
            mime_type: downloaded.mime_type.clone(),
            extension: extension.map(str::to_string),
            sha256: Some(downloaded.sha256.clone()),
            width: None,
            height: None,
            duration_ms: None,
            metadata: downloaded.metadata.clone(),
        };
        self.persist_provider_output(run_id, &output)
    }

    /// Worker-only variant that fences the write with its current lease.  The
    /// unowned method remains available for administrative/import callers.
    pub fn persist_provider_output_for_owner(
        &self,
        run_id: &str,
        owner: &str,
        output: &MediaProviderOutput,
    ) -> AppResult<MediaAsset> {
        self.ensure_live_lease(run_id, owner)?;
        self.persist_provider_output_inner(run_id, output, Some(owner))
    }

    /// Persist provider output using a temp file and atomic rename, then link
    /// it to the run. No user-provided path is accepted by this method.
    pub fn persist_provider_output(
        &self,
        run_id: &str,
        output: &MediaProviderOutput,
    ) -> AppResult<MediaAsset> {
        self.persist_provider_output_inner(run_id, output, None)
    }

    fn persist_provider_output_inner(
        &self,
        run_id: &str,
        output: &MediaProviderOutput,
        owner: Option<&str>,
    ) -> AppResult<MediaAsset> {
        validate_id(run_id, "runId")?;
        if output.bytes.len() as i64 > MAX_ASSET_BYTES {
            return Err(AppError::coded(
                "MEDIA_ASSET_TOO_LARGE",
                "provider output is too large",
            ));
        }
        let mime_type = output
            .mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !is_supported_media_mime(&mime_type) {
            return Err(AppError::coded(
                "MEDIA_MIME_INVALID",
                "provider output MIME type is invalid",
            ));
        }
        let run = self
            .get_run(run_id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        let node = self
            .get_node(&run.node_id)?
            .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
        let scope = self
            .scope_from_request(&node.workspace_id, &run.request)?
            .or(self.media_scope_from_value(&node.workspace_id, &node.parameters)?);
        let expected_prefix = match node.kind {
            MediaKind::Image => "image/",
            MediaKind::Video => "video/",
        };
        let is_poster = output
            .metadata
            .get("role")
            .or_else(|| output.metadata.get("assetRole"))
            .and_then(|value| value.as_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("poster"));
        if !mime_type.starts_with(expected_prefix)
            && !(node.kind == MediaKind::Video && is_poster && mime_type.starts_with("image/"))
        {
            return Err(AppError::coded(
                "MEDIA_MIME_INVALID",
                "provider output MIME type does not match the media node",
            ));
        }
        validate_json(&output.metadata)?;
        let (mut metadata, metadata_width, metadata_height, metadata_duration_ms) =
            normalize_output_metadata(&run.request, &output.metadata);
        if let Some(provider) = run.provider_ref.as_ref() {
            if let Some(object) = metadata.as_object_mut() {
                object.insert(
                    "providerId".to_string(),
                    serde_json::Value::String(provider.provider_id.clone()),
                );
                object.insert(
                    "model".to_string(),
                    serde_json::Value::String(provider.model_id.clone()),
                );
            }
        }
        let mut width = output.width.or(metadata_width);
        let mut height = output.height.or(metadata_height);
        let mut duration_ms = output.duration_ms.or(metadata_duration_ms);
        if width.is_some_and(|value| value < 0)
            || height.is_some_and(|value| value < 0)
            || duration_ms.is_some_and(|value| value < 0)
        {
            return Err(AppError::coded(
                "MEDIA_DIMENSIONS_INVALID",
                "media dimensions and duration must be non-negative",
            ));
        }
        if let Some(value) = output.width {
            if let Some(object) = metadata.as_object_mut() {
                object.insert("width".to_string(), serde_json::json!(value));
            }
        }
        if let Some(value) = output.height {
            if let Some(object) = metadata.as_object_mut() {
                object.insert("height".to_string(), serde_json::json!(value));
            }
        }
        if let Some(value) = output.duration_ms {
            if let Some(object) = metadata.as_object_mut() {
                object.insert("durationMs".to_string(), serde_json::json!(value));
            }
        }
        let digest = {
            let mut hasher = Sha256::new();
            hasher.update(&output.bytes);
            format!("{:x}", hasher.finalize())
        };
        if let Some(expected) = output.sha256.as_deref() {
            if !is_sha256(expected) || !expected.eq_ignore_ascii_case(&digest) {
                return Err(AppError::coded(
                    "MEDIA_HASH_MISMATCH",
                    "provider output hash does not match the downloaded bytes",
                ));
            }
        }
        let (root, storage_kind) = self.storage_root_for_scope(scope.as_ref())?;
        Self::merge_scope_metadata(&mut metadata, scope.as_ref(), storage_kind);
        let extension = output
            .extension
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| mime_extension(&output.mime_type));
        if !is_safe_media_extension(extension) || !extension_matches_mime(extension, &mime_type) {
            return Err(AppError::coded(
                "MEDIA_PATH_INVALID",
                "provider output extension is invalid",
            ));
        }
        let asset_id = uuid::Uuid::new_v4().to_string();
        let relative_path =
            Self::relative_asset_path(&node.workspace_id, scope.as_ref(), &asset_id, extension);
        let destination = root.join(&relative_path);
        let parent = destination.parent().ok_or_else(|| {
            AppError::coded("MEDIA_PATH_INVALID", "provider output path has no parent")
        })?;
        std::fs::create_dir_all(parent)?;
        let canonical_parent = dunce::canonicalize(parent)
            .map_err(|error| AppError::coded("MEDIA_ASSET_PATH_UNAVAILABLE", error.to_string()))?;
        if !canonical_parent.starts_with(&root) {
            return Err(AppError::coded(
                "MEDIA_PATH_INVALID",
                "provider output directory is not controlled by its media root",
            ));
        }
        let temp =
            destination.with_extension(format!("{}.part", extension.trim_start_matches('.')));
        let write_result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&output.bytes)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&temp);
            return Err(error.into());
        }
        if node.kind == MediaKind::Video && !is_poster {
            let report = self.media_probe.probe_path(&temp, &mime_type);
            (width, height, duration_ms) =
                apply_probe_report(&mut metadata, &report, width, height, duration_ms);
        }
        if let Err(error) = std::fs::rename(&temp, &destination) {
            let _ = std::fs::remove_file(&temp);
            return Err(error.into());
        }
        let sha256 = digest;
        let asset = MediaAsset {
            id: asset_id,
            workspace_id: node.workspace_id,
            run_id: Some(run_id.to_string()),
            relative_path,
            mime_type,
            size_bytes: output.bytes.len() as i64,
            sha256: Some(sha256),
            width,
            height,
            duration_ms,
            metadata,
            created_at: now(),
        };
        if let Some(owner) = owner {
            let inserted = self
                .repo
                .insert_asset_for_run_owner(&asset, owner)
                .map_err(AppError::from)?;
            if !inserted {
                let _ = std::fs::remove_file(&destination);
                return Err(AppError::coded(
                    "MEDIA_LEASE_LOST",
                    "media run lease is no longer owned by this worker",
                ));
            }
        } else {
            if let Err(error) = self.repo.insert_asset(&asset) {
                let _ = std::fs::remove_file(&destination);
                return Err(AppError::from(error));
            }
            let mut updated_run = run;
            updated_run.output_asset_ids.push(asset.id.clone());
            if let Err(error) = self.repo.replace_run_assets_for_run(&updated_run) {
                let _ = self.repo.delete_asset(&asset.id);
                let _ = std::fs::remove_file(&destination);
                return Err(AppError::from(error));
            }
        }
        Ok(asset)
    }

    pub fn transition_run(
        &self,
        id: &str,
        next: MediaRunStatus,
        progress: Option<i32>,
        error_code: Option<String>,
        error_message: Option<String>,
    ) -> AppResult<MediaRun> {
        self.transition_run_with_update(id, next, progress, error_code, error_message, None)
    }

    /// Fenced state transition for the background worker.
    pub fn transition_run_for_owner(
        &self,
        id: &str,
        owner: &str,
        next: MediaRunStatus,
        progress: Option<i32>,
        error_code: Option<String>,
        error_message: Option<String>,
    ) -> AppResult<MediaRun> {
        self.ensure_live_lease(id, owner)?;
        self.transition_run_with_update(id, next, progress, error_code, error_message, Some(owner))
    }

    fn transition_run_with_update(
        &self,
        id: &str,
        next: MediaRunStatus,
        progress: Option<i32>,
        error_code: Option<String>,
        error_message: Option<String>,
        owner: Option<&str>,
    ) -> AppResult<MediaRun> {
        let existing = self
            .repo
            .get_run(id)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if !existing.status.can_transition_to(next) {
            return Err(AppError::coded(
                "MEDIA_INVALID_TRANSITION",
                format!(
                    "cannot transition media run from {} to {}",
                    existing.status, next
                ),
            ));
        }
        validate_progress(progress)?;
        let update = UpdateMediaRunRequest {
            status: Some(next),
            progress: Some(progress),
            error_code: Some(error_code),
            error_message: Some(error_message),
            ..Default::default()
        };
        let updated_at = now();
        let changed = match owner {
            Some(owner) => self.repo.update_run_for_owner_from_status(
                id,
                owner,
                &updated_at,
                existing.status,
                &update,
                &updated_at,
            ),
            None => self
                .repo
                .update_run_from_status(id, existing.status, &update, &updated_at),
        }
        .map_err(AppError::from)?;
        if !changed {
            return Err(if owner.is_some() {
                AppError::coded(
                    "MEDIA_LEASE_LOST",
                    "media run lease is no longer owned by this worker",
                )
            } else {
                AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found")
            });
        }
        self.get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run disappeared"))
    }

    fn ensure_live_lease(&self, id: &str, owner: &str) -> AppResult<MediaRun> {
        validate_id(id, "runId")?;
        if !valid_lease_owner(owner) {
            return Err(AppError::coded(
                "MEDIA_LEASE_OWNER_INVALID",
                "lease owner is invalid",
            ));
        }
        let run = self
            .get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if run.lease_owner.as_deref() != Some(owner)
            || !lease_is_live(run.lease_expires_at.as_deref())
        {
            return Err(AppError::coded(
                "MEDIA_LEASE_LOST",
                "media run lease is no longer live",
            ));
        }
        Ok(run)
    }

    fn validate_registered_asset_file(&self, asset: &MediaAsset) -> AppResult<()> {
        let Some(_root) = self.media_root.as_ref() else {
            // Metadata-only repositories are useful for migrations and tests;
            // production services always configure a media root.
            return Ok(());
        };
        let candidate = self
            .asset_path_candidates(asset)?
            .into_iter()
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| AppError::coded("MEDIA_ASSET_NOT_FOUND", "asset file was not found"))?;
        self.verify_asset_file(&candidate, asset)
    }

    pub fn cancel_run(&self, id: &str) -> AppResult<MediaRun> {
        let run = self
            .get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if run.status.is_terminal() {
            return Ok(run);
        }
        let next = if run.status == MediaRunStatus::Queued {
            MediaRunStatus::Canceled
        } else {
            MediaRunStatus::Canceling
        };
        self.transition_run(id, next, run.progress, None, None)
    }

    pub fn retry_run(&self, id: &str) -> AppResult<MediaRun> {
        let run = self
            .get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
        if !matches!(
            run.status,
            MediaRunStatus::Failed | MediaRunStatus::Canceled
        ) {
            return Err(AppError::coded(
                "MEDIA_RETRY_NOT_ALLOWED",
                "only failed or canceled media runs can be retried",
            ));
        }
        let changed = self.repo.retry_run(id, &now()).map_err(AppError::from)?;
        if !changed {
            return Err(AppError::coded(
                "MEDIA_RETRY_CONFLICT",
                "media run changed before it could be retried",
            ));
        }
        self.get_run(id)?
            .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run disappeared"))
    }

    pub fn create_asset(&self, req: CreateMediaAssetRequest) -> AppResult<MediaAsset> {
        validate_scope(&req.workspace_id, "asset")?;
        validate_relative_media_path(&req.relative_path)?;
        validate_asset_path_for_workspace(&req.relative_path, &req.workspace_id)?;
        let registered_extension = req.relative_path.rsplit('.').next().unwrap_or_default();
        if req.size_bytes < 0 || req.size_bytes > MAX_ASSET_BYTES {
            return Err(AppError::coded(
                "MEDIA_ASSET_TOO_LARGE",
                "asset size is out of range",
            ));
        }
        let mime_type = req
            .mime_type
            .trim()
            .split(';')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !is_supported_media_mime(&mime_type) {
            return Err(AppError::coded(
                "MEDIA_MIME_INVALID",
                "asset MIME type is invalid",
            ));
        }
        if !is_safe_media_extension(registered_extension)
            || !extension_matches_mime(registered_extension, &mime_type)
        {
            return Err(AppError::coded(
                "MEDIA_PATH_INVALID",
                "asset extension does not match its MIME type",
            ));
        }
        if req.sha256.as_deref().is_some_and(|hash| !is_sha256(hash))
            || req.width.is_some_and(|value| value < 0)
            || req.height.is_some_and(|value| value < 0)
            || req.duration_ms.is_some_and(|value| value < 0)
        {
            return Err(AppError::coded(
                "MEDIA_ASSET_METADATA_INVALID",
                "asset metadata is invalid",
            ));
        }
        if let Some(metadata) = req.metadata.as_ref() {
            validate_json(metadata)?;
        }
        let scope = req
            .metadata
            .as_ref()
            .map(|metadata| self.media_scope_from_value(&req.workspace_id, metadata))
            .transpose()?
            .flatten();
        if let Some(scope) = scope.as_ref() {
            validate_asset_path_for_scope(&req.relative_path, &scope.project_id)?;
        }
        if let Some(run_id) = req.run_id.as_deref() {
            validate_id(run_id, "runId")?;
            let run = self
                .get_run(run_id)?
                .ok_or_else(|| AppError::coded("MEDIA_RUN_NOT_FOUND", "media run not found"))?;
            let node = self
                .get_node(&run.node_id)?
                .ok_or_else(|| AppError::coded("MEDIA_NODE_NOT_FOUND", "media node not found"))?;
            if node.workspace_id != req.workspace_id {
                return Err(AppError::coded(
                    "MEDIA_WORKSPACE_MISMATCH",
                    "run belongs to another workspace",
                ));
            }
            if !mime_matches_kind(&mime_type, Some(node.kind)) {
                return Err(AppError::coded(
                    "MEDIA_ASSET_KIND_MISMATCH",
                    "asset MIME type does not match the media node",
                ));
            }
        }
        let asset = MediaAsset {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: req.workspace_id,
            run_id: req.run_id,
            relative_path: req.relative_path,
            mime_type,
            size_bytes: req.size_bytes,
            sha256: req.sha256,
            width: req.width,
            height: req.height,
            duration_ms: req.duration_ms,
            metadata: req.metadata.unwrap_or_else(|| serde_json::json!({})),
            created_at: now(),
        };
        self.validate_registered_asset_file(&asset)?;
        self.repo.insert_asset(&asset).map_err(AppError::from)?;
        Ok(asset)
    }

    /// Persist a user-selected reference asset inside the controlled media
    /// root and register it without associating it with a generated run yet.
    /// The worker can then safely load it through `inputAssetIds`.
    pub fn stage_input(&self, req: StageMediaInputRequest) -> AppResult<MediaAsset> {
        validate_scope(&req.workspace_id, "asset")?;
        let mime_type = req
            .mime_type
            .trim()
            .split(';')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !is_supported_media_mime(&mime_type) {
            return Err(AppError::coded(
                "MEDIA_MIME_INVALID",
                "asset MIME type is invalid",
            ));
        }
        let filename = req
            .filename
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .trim();
        let mut metadata = req.metadata.unwrap_or_else(|| serde_json::json!({}));
        let metadata_object = metadata.as_object_mut().ok_or_else(|| {
            AppError::coded(
                "MEDIA_ASSET_METADATA_INVALID",
                "staged input metadata must be a JSON object",
            )
        })?;
        if let Some(role) = metadata_object.get("role").and_then(|value| value.as_str()) {
            if !matches!(role, "reference" | "mask") {
                return Err(AppError::coded(
                    "MEDIA_ASSET_METADATA_INVALID",
                    "staged input role must be reference or mask",
                ));
            }
        } else {
            metadata_object.insert(
                "role".to_string(),
                serde_json::Value::String("reference".to_string()),
            );
        }
        metadata_object.insert(
            "source".to_string(),
            serde_json::Value::String("user-input".to_string()),
        );
        metadata_object.insert(
            "filename".to_string(),
            serde_json::Value::String(filename.to_string()),
        );
        validate_json(&metadata)?;
        let scope = self.media_scope_from_value(&req.workspace_id, &metadata)?;
        let (root, storage_kind) = self.storage_root_for_scope(scope.as_ref())?;
        Self::merge_scope_metadata(&mut metadata, scope.as_ref(), storage_kind);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(req.data.trim())
            .map_err(|error| AppError::coded("MEDIA_DATA_INVALID", error.to_string()))?;
        if bytes.is_empty() || bytes.len() as i64 > 64 * 1024 * 1024 {
            return Err(AppError::coded(
                "MEDIA_ASSET_TOO_LARGE",
                "input asset is empty or exceeds 64MB",
            ));
        }
        let requested_extension = filename
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let extension = if is_safe_media_extension(&requested_extension)
            && extension_matches_mime(&requested_extension, &mime_type)
        {
            requested_extension
        } else {
            mime_extension(&mime_type).to_string()
        };
        if !is_safe_media_extension(&extension) || !extension_matches_mime(&extension, &mime_type) {
            return Err(AppError::coded(
                "MEDIA_PATH_INVALID",
                "input filename extension does not match MIME type",
            ));
        }
        let asset_id = uuid::Uuid::new_v4().to_string();
        let relative_path =
            Self::relative_asset_path(&req.workspace_id, scope.as_ref(), &asset_id, &extension);
        let destination = root.join(&relative_path);
        let parent = destination
            .parent()
            .ok_or_else(|| AppError::coded("MEDIA_PATH_INVALID", "input path has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let canonical_parent = dunce::canonicalize(parent)
            .map_err(|error| AppError::coded("MEDIA_ASSET_PATH_UNAVAILABLE", error.to_string()))?;
        if !canonical_parent.starts_with(&root) {
            return Err(AppError::coded(
                "MEDIA_PATH_INVALID",
                "input directory is not controlled by its media root",
            ));
        }
        let temp = destination.with_extension(format!("{}.part", extension));
        let write_result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&temp);
            return Err(error.into());
        }
        let (width, height, duration_ms) = if mime_type.starts_with("video/") {
            let report = self.media_probe.probe_path(&temp, &mime_type);
            apply_probe_report(&mut metadata, &report, None, None, None)
        } else {
            (None, None, None)
        };
        if let Err(error) = std::fs::rename(&temp, &destination) {
            let _ = std::fs::remove_file(&temp);
            return Err(error.into());
        }
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let asset = MediaAsset {
            id: asset_id,
            workspace_id: req.workspace_id,
            run_id: None,
            relative_path,
            mime_type,
            size_bytes: bytes.len() as i64,
            sha256: Some(format!("{:x}", hasher.finalize())),
            width,
            height,
            duration_ms,
            metadata,
            created_at: now(),
        };
        if let Err(error) = self.repo.insert_asset(&asset) {
            let _ = std::fs::remove_file(&destination);
            return Err(AppError::from(error));
        }
        Ok(asset)
    }

    pub fn get_asset(&self, id: &str) -> AppResult<Option<MediaAsset>> {
        validate_id(id, "assetId")?;
        self.repo.get_asset(id).map_err(AppError::from)
    }

    pub fn list_assets(
        &self,
        workspace_id: &str,
        run_id: Option<&str>,
    ) -> AppResult<Vec<MediaAsset>> {
        validate_scope(workspace_id, "assets")?;
        if let Some(run_id) = run_id {
            validate_id(run_id, "runId")?;
        }
        self.repo
            .list_assets(workspace_id, run_id)
            .map_err(AppError::from)
    }

    pub fn create_edge(&self, req: CreateMediaEdgeRequest) -> AppResult<MediaEdge> {
        validate_scope(&req.workspace_id, &req.layout_id)?;
        for (value, field) in [
            (&req.source_node_id, "sourceNodeId"),
            (&req.target_node_id, "targetNodeId"),
            (&req.source_port, "sourcePort"),
            (&req.target_port, "targetPort"),
        ] {
            validate_id(value, field)?;
        }
        if req.source_node_id == req.target_node_id {
            return Err(AppError::coded(
                "MEDIA_EDGE_CYCLE",
                "a media node cannot connect to itself",
            ));
        }
        let source = self.get_node(&req.source_node_id)?.ok_or_else(|| {
            AppError::coded("MEDIA_NODE_NOT_FOUND", "source media node not found")
        })?;
        let target = self.get_node(&req.target_node_id)?.ok_or_else(|| {
            AppError::coded("MEDIA_NODE_NOT_FOUND", "target media node not found")
        })?;
        if source.deleted_at.is_some() || target.deleted_at.is_some() {
            return Err(AppError::coded(
                "MEDIA_NODE_DELETED",
                "edges cannot reference deleted media nodes",
            ));
        }
        if source.workspace_id != req.workspace_id
            || target.workspace_id != req.workspace_id
            || source.layout_id != req.layout_id
            || target.layout_id != req.layout_id
        {
            return Err(AppError::coded(
                "MEDIA_WORKSPACE_MISMATCH",
                "edge nodes must share workspace and layout",
            ));
        }
        let source_scope = self.media_scope_from_value(&source.workspace_id, &source.parameters)?;
        let target_scope = self.media_scope_from_value(&target.workspace_id, &target.parameters)?;
        if source_scope.as_ref().map(|scope| &scope.project_id)
            != target_scope.as_ref().map(|scope| &scope.project_id)
        {
            return Err(AppError::coded(
                "MEDIA_PROJECT_MISMATCH",
                "edge nodes must share a project scope",
            ));
        }
        let selector = req.selector.unwrap_or(MediaEdgeSelector::LatestSucceeded);
        if selector == MediaEdgeSelector::SpecificAsset && req.asset_id.is_none() {
            return Err(AppError::coded(
                "MEDIA_ASSET_REQUIRED",
                "specific asset selector requires assetId",
            ));
        }
        if selector == MediaEdgeSelector::LatestSucceeded && req.asset_id.is_some() {
            return Err(AppError::coded(
                "MEDIA_ASSET_UNEXPECTED",
                "latest succeeded selector cannot include assetId",
            ));
        }
        if let Some(asset_id) = req.asset_id.as_deref() {
            validate_id(asset_id, "assetId")?;
            let asset = self
                .get_asset(asset_id)?
                .ok_or_else(|| AppError::coded("MEDIA_ASSET_NOT_FOUND", "edge asset not found"))?;
            if asset.workspace_id != req.workspace_id {
                return Err(AppError::coded(
                    "MEDIA_WORKSPACE_MISMATCH",
                    "edge asset belongs to another workspace",
                ));
            }
            if !mime_matches_kind(&asset.mime_type, Some(source.kind)) {
                let is_video_poster = source.kind == MediaKind::Video
                    && asset
                        .metadata
                        .get("role")
                        .or_else(|| asset.metadata.get("assetRole"))
                        .and_then(|value| value.as_str())
                        .is_some_and(|value| value.eq_ignore_ascii_case("poster"));
                if is_video_poster {
                    return Err(AppError::coded(
                        "MEDIA_EDGE_ASSET_INVALID",
                        "a poster asset cannot be used as a video data edge",
                    ));
                }
                return Err(AppError::coded(
                    "MEDIA_EDGE_KIND_MISMATCH",
                    "edge asset type does not match the source media node",
                ));
            }
            let Some(run_id) = asset.run_id.as_deref() else {
                return Err(AppError::coded(
                    "MEDIA_EDGE_ASSET_INVALID",
                    "specific edge asset must belong to a media run",
                ));
            };
            let run = self.get_run(run_id)?.ok_or_else(|| {
                AppError::coded("MEDIA_RUN_NOT_FOUND", "edge asset run not found")
            })?;
            if run.node_id != source.id || run.status != MediaRunStatus::Succeeded {
                return Err(AppError::coded(
                    "MEDIA_EDGE_ASSET_INVALID",
                    "specific edge asset must be a succeeded output of the source node",
                ));
            }
        }
        if self.would_create_edge_cycle(&req.source_node_id, &req.target_node_id)? {
            return Err(AppError::coded(
                "MEDIA_EDGE_CYCLE",
                "media edge would create a cycle",
            ));
        }
        let edge = MediaEdge {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: req.workspace_id,
            layout_id: req.layout_id,
            source_node_id: req.source_node_id,
            source_port: req.source_port,
            target_node_id: req.target_node_id,
            target_port: req.target_port,
            selector,
            asset_id: req.asset_id,
            created_at: now(),
        };
        self.repo.insert_edge(&edge).map_err(AppError::from)?;
        Ok(edge)
    }

    fn would_create_edge_cycle(
        &self,
        source_node_id: &str,
        target_node_id: &str,
    ) -> AppResult<bool> {
        let workspace_edges = self
            .repo
            .list_edges(
                &self
                    .get_node(source_node_id)?
                    .ok_or_else(|| {
                        AppError::coded("MEDIA_NODE_NOT_FOUND", "source node not found")
                    })?
                    .workspace_id,
                None,
            )
            .map_err(AppError::from)?;
        let mut outgoing: std::collections::HashMap<&str, Vec<&str>> =
            std::collections::HashMap::new();
        for edge in &workspace_edges {
            outgoing
                .entry(edge.source_node_id.as_str())
                .or_default()
                .push(edge.target_node_id.as_str());
        }
        let mut stack = vec![target_node_id];
        let mut visited = std::collections::HashSet::new();
        while let Some(node) = stack.pop() {
            if node == source_node_id {
                return Ok(true);
            }
            if !visited.insert(node) {
                continue;
            }
            if let Some(next) = outgoing.get(node) {
                stack.extend(next.iter().copied());
            }
        }
        Ok(false)
    }

    pub fn get_edge(&self, id: &str) -> AppResult<Option<MediaEdge>> {
        validate_id(id, "edgeId")?;
        self.repo.get_edge(id).map_err(AppError::from)
    }

    pub fn list_edges(
        &self,
        workspace_id: &str,
        layout_id: Option<&str>,
    ) -> AppResult<Vec<MediaEdge>> {
        validate_scope(workspace_id, "edges")?;
        if let Some(layout_id) = layout_id {
            validate_id(layout_id, "layoutId")?;
        }
        self.repo
            .list_edges(workspace_id, layout_id)
            .map_err(AppError::from)
    }

    pub fn delete_edge(&self, id: &str) -> AppResult<bool> {
        validate_id(id, "edgeId")?;
        self.repo.delete_edge(id).map_err(AppError::from)
    }
}

/// Normalize provider metadata into the small, stable set consumed by the
/// Canvas and history replay. Providers commonly use snake_case, camelCase,
/// or seconds for duration; the persisted asset always exposes camelCase and
/// milliseconds while retaining unknown provider fields.
fn normalize_output_metadata(
    request: &serde_json::Value,
    raw: &serde_json::Value,
) -> (serde_json::Value, Option<i64>, Option<i64>, Option<i64>) {
    let mut metadata = match raw {
        serde_json::Value::Object(object) => object.clone(),
        _ => serde_json::Map::new(),
    };
    // Provider URLs can contain signed credentials. Preview URLs are resolved
    // through the local MediaAsset endpoint, so retaining them is unnecessary
    // and would make a persisted metadata snapshot a secret sink.
    for key in ["url", "sourceUrl", "source_url", "previewUrl", "posterUrl"] {
        metadata.remove(key);
    }
    let width = metadata_i64(&metadata, &["width", "videoWidth", "video_width"]);
    let height = metadata_i64(&metadata, &["height", "videoHeight", "video_height"]);
    let duration_ms = metadata_i64(&metadata, &["durationMs", "duration_ms"])
        .or_else(|| {
            metadata_number(&metadata, &["durationSeconds", "duration_seconds"])
                .map(|value| (value * 1000.0).round() as i64)
        })
        .or_else(|| {
            metadata_number(&metadata, &["duration"]).map(|value| {
                // Generic media APIs almost universally express `duration` in
                // seconds; a very large value is treated as an already-ms value
                // to accommodate ffprobe/Comfy custom-node metadata.
                if value > 10_000.0 {
                    value.round() as i64
                } else {
                    (value * 1000.0).round() as i64
                }
            })
        });
    if let Some(value) = width {
        metadata.insert("width".to_string(), serde_json::json!(value));
    }
    if let Some(value) = height {
        metadata.insert("height".to_string(), serde_json::json!(value));
    }
    if let Some(value) = duration_ms {
        metadata.insert("durationMs".to_string(), serde_json::json!(value));
    }
    if let Some(value) = metadata_number(&metadata, &["fps", "frameRate", "frame_rate"]) {
        metadata.insert("fps".to_string(), serde_json::json!(value));
    }
    if let Some(value) = metadata_i64(&metadata, &["frameCount", "frame_count", "frames"]) {
        metadata.insert("frameCount".to_string(), serde_json::json!(value));
    }
    if let Some(value) = metadata_bool(&metadata, &["audio", "hasAudio", "has_audio"]) {
        metadata.insert("audio".to_string(), serde_json::Value::Bool(value));
    }
    for (canonical, aliases) in [
        ("codec", &["codec", "videoCodec", "video_codec"][..]),
        (
            "colorSpace",
            &["colorSpace", "color_space", "colorspace"][..],
        ),
    ] {
        if let Some(value) = metadata_string(&metadata, aliases) {
            metadata.insert(canonical.to_string(), serde_json::Value::String(value));
        }
    }
    for (canonical, aliases) in [
        ("audioCodec", &["audioCodec", "audio_codec"][..]),
        ("audioChannels", &["audioChannels", "audio_channels"][..]),
        ("sampleRate", &["sampleRate", "sample_rate"][..]),
        ("bitDepth", &["bitDepth", "bit_depth"][..]),
    ] {
        if let Some(value) = if canonical == "audioCodec" {
            metadata_string(&metadata, aliases).map(serde_json::Value::String)
        } else {
            metadata_i64(&metadata, aliases).map(|value| serde_json::json!(value))
        } {
            metadata.insert(canonical.to_string(), value);
        }
    }
    for (canonical, aliases) in [
        (
            "pixelFormat",
            &["pixelFormat", "pixel_format", "pix_fmt"][..],
        ),
        ("colorTransfer", &["colorTransfer", "color_transfer"][..]),
        ("colorPrimaries", &["colorPrimaries", "color_primaries"][..]),
    ] {
        if let Some(value) = metadata_string(&metadata, aliases) {
            metadata.insert(canonical.to_string(), serde_json::Value::String(value));
        }
    }

    // Persist only replay-safe generation fields, never the full workflow or
    // arbitrary provider configuration. This makes each asset self-describing
    // without turning metadata into a second secret-bearing request snapshot.
    if let Some(prompt) = request.get("prompt").and_then(|value| value.as_str()) {
        metadata.insert(
            "prompt".to_string(),
            serde_json::Value::String(prompt.chars().take(16_384).collect()),
        );
    }
    if let Some(parameters) = request
        .get("parameters")
        .and_then(|value| value.as_object())
    {
        for key in [
            "negativePrompt",
            "negative_prompt",
            "seed",
            "seedMode",
            "seed_mode",
            "variantSeeds",
            "variant_seeds",
            "n",
            "batchSize",
            "batch_size",
            "size",
            "aspectRatio",
            "aspect_ratio",
            "quality",
            "resolution",
            "duration",
            "durationSeconds",
            "duration_seconds",
            "fps",
            "frameCount",
            "frame_count",
            "audio",
            "audioCodec",
            "audio_codec",
            "audioChannels",
            "audio_channels",
            "sampleRate",
            "sample_rate",
            "bitDepth",
            "bit_depth",
            "pixelFormat",
            "pixel_format",
            "colorTransfer",
            "color_transfer",
            "colorPrimaries",
            "color_primaries",
            "codec",
            "colorSpace",
            "color_space",
            "workflowFingerprint",
            "schemaFingerprint",
        ] {
            if let Some(value) = parameters.get(key) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
    }
    (
        serde_json::Value::Object(metadata),
        width,
        height,
        duration_ms,
    )
}

/// Merge facts from the local probe into provider metadata. Probe values win
/// because they describe the persisted bytes; a conflict is retained for
/// diagnostics instead of silently hiding a provider/schema mismatch.
fn apply_probe_report(
    metadata: &mut serde_json::Value,
    report: &MediaProbeReport,
    fallback_width: Option<i64>,
    fallback_height: Option<i64>,
    fallback_duration_ms: Option<i64>,
) -> (Option<i64>, Option<i64>, Option<i64>) {
    let Some(object) = metadata.as_object_mut() else {
        return (fallback_width, fallback_height, fallback_duration_ms);
    };
    object.remove("probeTool");
    object.remove("probeReason");
    object.insert(
        "probeStatus".to_string(),
        serde_json::Value::String(report.status.as_str().to_string()),
    );
    if let Some(tool) = report.tool.as_deref() {
        object.insert(
            "probeTool".to_string(),
            serde_json::Value::String(tool.to_string()),
        );
    }
    if let Some(reason) = report.reason.as_deref() {
        object.insert(
            "probeReason".to_string(),
            serde_json::Value::String(reason.to_string()),
        );
    }
    let mut conflicts = Vec::new();
    for (key, value) in [
        (
            "container",
            report
                .container
                .as_ref()
                .map(|value| serde_json::json!(value)),
        ),
        ("width", report.width.map(|value| serde_json::json!(value))),
        (
            "height",
            report.height.map(|value| serde_json::json!(value)),
        ),
        (
            "durationMs",
            report.duration_ms.map(|value| serde_json::json!(value)),
        ),
        ("fps", report.fps.map(|value| serde_json::json!(value))),
        (
            "frameCount",
            report.frame_count.map(|value| serde_json::json!(value)),
        ),
        ("audio", report.audio.map(|value| serde_json::json!(value))),
        (
            "codec",
            report.codec.as_ref().map(|value| serde_json::json!(value)),
        ),
        (
            "audioCodec",
            report
                .audio_codec
                .as_ref()
                .map(|value| serde_json::json!(value)),
        ),
        (
            "audioChannels",
            report.audio_channels.map(|value| serde_json::json!(value)),
        ),
        (
            "sampleRate",
            report.sample_rate.map(|value| serde_json::json!(value)),
        ),
        (
            "colorSpace",
            report
                .color_space
                .as_ref()
                .map(|value| serde_json::json!(value)),
        ),
        (
            "colorTransfer",
            report
                .color_transfer
                .as_ref()
                .map(|value| serde_json::json!(value)),
        ),
        (
            "colorPrimaries",
            report
                .color_primaries
                .as_ref()
                .map(|value| serde_json::json!(value)),
        ),
        (
            "pixelFormat",
            report
                .pixel_format
                .as_ref()
                .map(|value| serde_json::json!(value)),
        ),
        (
            "bitDepth",
            report.bit_depth.map(|value| serde_json::json!(value)),
        ),
    ] {
        if let Some(value) = value {
            set_probe_field(object, &mut conflicts, key, value);
        }
    }
    if !conflicts.is_empty() {
        object.insert(
            "probeConflicts".to_string(),
            serde_json::Value::Array(conflicts),
        );
    }
    (
        report.width.or(fallback_width),
        report.height.or(fallback_height),
        report.duration_ms.or(fallback_duration_ms),
    )
}

fn set_probe_field(
    object: &mut serde_json::Map<String, serde_json::Value>,
    conflicts: &mut Vec<serde_json::Value>,
    key: &str,
    value: serde_json::Value,
) {
    if let Some(previous) = object.get(key) {
        if previous != &value {
            conflicts.push(serde_json::json!({
                "field": key,
                "provider": previous,
                "probed": value,
            }));
        }
    }
    object.insert(key.to_string(), value);
}

fn metadata_number(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<f64> {
    keys.iter().find_map(|key| match object.get(*key) {
        Some(serde_json::Value::Number(value)) => value
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0),
        Some(serde_json::Value::String(value)) => value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0),
        _ => None,
    })
}

fn metadata_i64(object: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<i64> {
    metadata_number(object, keys)
        .and_then(|value| (value <= i64::MAX as f64).then_some(value.round() as i64))
}

fn metadata_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<bool> {
    keys.iter().find_map(|key| match object.get(*key) {
        Some(serde_json::Value::Bool(value)) => Some(*value),
        Some(serde_json::Value::String(value)) => match value.to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn metadata_string(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(|value| value.as_str())
            .map(|value| value.chars().take(128).collect())
    })
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn execution_fingerprint_with_provider_config(
    node: &MediaNode,
    req: &CreateMediaRunRequest,
    input_assets: &[MediaAsset],
    provider_config_fingerprint: Option<&str>,
) -> AppResult<String> {
    let inputs = input_assets
        .iter()
        .map(|asset| {
            // Staged assets are content-addressed. Keep a path fallback only
            // for legacy metadata-only assets that have no recorded hash.
            let content_identity = asset
                .sha256
                .as_deref()
                .map(|sha256| serde_json::json!({ "sha256": sha256 }))
                .unwrap_or_else(|| {
                    serde_json::json!({
                        "relativePath": asset.relative_path,
                        "sizeBytes": asset.size_bytes,
                    })
                });
            serde_json::json!({
                "content": content_identity,
                "mimeType": asset.mime_type,
                "width": asset.width,
                "height": asset.height,
                "durationMs": asset.duration_ms,
                "role": asset
                    .metadata
                    .get("role")
                    .or_else(|| asset.metadata.get("assetRole")),
            })
        })
        .collect::<Vec<_>>();
    let mut request = req.request.clone();
    if let Some(object) = request.as_object_mut() {
        // These fields describe history/UI lineage, not provider execution.
        object.remove("replayOfRunId");
        object.remove("replay_of_run_id");
    }
    let payload = serde_json::json!({
        "version": EXECUTION_FINGERPRINT_VERSION,
        "kind": node.kind,
        "operation": req.operation,
        "provider": node.provider_ref,
        "providerConfigFingerprint": provider_config_fingerprint,
        "nodeParameters": node.parameters,
        "request": request,
        "inputs": inputs,
    });
    crate::services::json_fingerprint(&payload)
}

fn default_operation(kind: MediaKind) -> MediaOperation {
    match kind {
        MediaKind::Image => MediaOperation::TextToImage,
        MediaKind::Video => MediaOperation::TextToVideo,
    }
}

fn validate_operation_kind(kind: MediaKind, operation: MediaOperation) -> AppResult<()> {
    if !operation.supports_kind(kind) {
        return Err(AppError::coded(
            "MEDIA_OPERATION_KIND_MISMATCH",
            format!("operation {operation} does not produce {kind}"),
        ));
    }
    Ok(())
}

fn validate_scope(workspace_id: &str, layout_id: &str) -> AppResult<()> {
    validate_id(workspace_id, "workspaceId")?;
    validate_id(layout_id, "layoutId")
}

fn input_kind(node_kind: MediaKind, operation: MediaOperation) -> Option<MediaKind> {
    match operation {
        MediaOperation::ImageToImage | MediaOperation::ImageToVideo => Some(MediaKind::Image),
        MediaOperation::Edit | MediaOperation::Upscale | MediaOperation::Extend => Some(node_kind),
        MediaOperation::TextToImage | MediaOperation::TextToVideo => None,
    }
}

fn mime_matches_kind(mime: &str, kind: Option<MediaKind>) -> bool {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match kind {
        Some(MediaKind::Image) => normalized.starts_with("image/"),
        Some(MediaKind::Video) => normalized.starts_with("video/"),
        None => true,
    }
}

fn is_supported_media_mime(mime: &str) -> bool {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    (normalized.starts_with("image/") || normalized.starts_with("video/"))
        && normalized != "image/svg+xml"
        && normalized != "image/svg"
}

fn validate_asset_path_for_workspace(path: &str, workspace_id: &str) -> AppResult<()> {
    let first = path.split('/').next().unwrap_or_default();
    if first != workspace_id {
        return Err(AppError::coded(
            "MEDIA_PATH_INVALID",
            "asset path must stay inside its workspace directory",
        ));
    }
    Ok(())
}

fn validate_asset_path_for_scope(path: &str, project_id: &str) -> AppResult<()> {
    let second = path.split('/').nth(1).unwrap_or_default();
    if second != project_id {
        return Err(AppError::coded(
            "MEDIA_PATH_INVALID",
            "scoped asset path must stay inside its project directory",
        ));
    }
    Ok(())
}

fn extension_matches_mime(extension: &str, mime: &str) -> bool {
    let extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match mime.split(';').next().unwrap_or(mime).trim() {
        "image/png" => extension == "png",
        "image/jpeg" => matches!(extension.as_str(), "jpg" | "jpeg"),
        "image/gif" => extension == "gif",
        "image/webp" => extension == "webp",
        "image/avif" => extension == "avif",
        "video/mp4" => matches!(extension.as_str(), "mp4" | "m4v"),
        "video/webm" => extension == "webm",
        "video/quicktime" => extension == "mov",
        "video/x-matroska" => extension == "mkv",
        _ => false,
    }
}

fn valid_lease_owner(owner: &str) -> bool {
    let owner = owner.trim();
    !owner.is_empty()
        && owner.len() <= MAX_LEASE_OWNER_BYTES
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn lease_is_live(expires_at: Option<&str>) -> bool {
    expires_at
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|value| value.with_timezone(&Utc) > Utc::now())
}

fn validate_progress(progress: Option<i32>) -> AppResult<()> {
    if progress.is_some_and(|value| !(0..=100).contains(&value)) {
        return Err(AppError::coded(
            "MEDIA_PROGRESS_INVALID",
            "progress must be 0..100",
        ));
    }
    Ok(())
}

fn validate_priority(priority: i32) -> AppResult<()> {
    if !(MEDIA_PRIORITY_MIN..=MEDIA_PRIORITY_MAX).contains(&priority) {
        return Err(AppError::coded(
            "MEDIA_PRIORITY_INVALID",
            format!("media priority must be between {MEDIA_PRIORITY_MIN} and {MEDIA_PRIORITY_MAX}"),
        ));
    }
    Ok(())
}

fn validate_id(value: &str, field: &str) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AppError::coded(
            "MEDIA_ID_INVALID",
            format!("{field} is invalid"),
        ));
    }
    Ok(())
}

fn validate_provider_config_fingerprint(value: Option<&str>) -> AppResult<()> {
    if value.is_some_and(|value| !is_sha256(value)) {
        return Err(AppError::coded(
            "MEDIA_PROVIDER_CONFIG_FINGERPRINT_INVALID",
            "provider configuration fingerprint must be a SHA-256 digest",
        ));
    }
    Ok(())
}

fn clean_title(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_TITLE_BYTES {
        return Err(AppError::coded(
            "MEDIA_TITLE_INVALID",
            "media title is empty or too long",
        ));
    }
    Ok(value.to_string())
}

fn validate_json(value: &serde_json::Value) -> AppResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| AppError::from(e.to_string()))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(AppError::coded(
            "MEDIA_PARAMETERS_TOO_LARGE",
            "media JSON exceeds size limit",
        ));
    }
    Ok(())
}

fn validate_parameters(value: &serde_json::Value) -> AppResult<()> {
    validate_json(value)?;
    if !value.is_null() && !value.is_object() {
        return Err(AppError::coded(
            "MEDIA_PARAMETERS_INVALID",
            "media node parameters must be a JSON object",
        ));
    }
    Ok(())
}

/// Merge a replay override into either the modern nested parameter object or
/// the legacy top-level request shape. Keeping the legacy shape intact avoids
/// changing the request envelope merely because a historical run was copied.
fn merge_replay_parameters(
    object: &mut serde_json::Map<String, serde_json::Value>,
    parameters: serde_json::Value,
) -> AppResult<()> {
    validate_json(&parameters)?;
    let next = parameters.as_object().ok_or_else(|| {
        AppError::coded(
            "MEDIA_PARAMETERS_INVALID",
            "replay parameters must be a JSON object",
        )
    })?;
    if let Some(current) = object.get_mut("parameters") {
        let current_object = current.as_object_mut().ok_or_else(|| {
            AppError::coded(
                "MEDIA_PARAMETERS_INVALID",
                "existing media parameters must be a JSON object",
            )
        })?;
        current_object.extend(next.clone());
        return Ok(());
    }
    for (key, value) in next {
        object.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn validate_generation_parameters(request: &serde_json::Value) -> AppResult<()> {
    let Some(object) = request.as_object() else {
        return Ok(());
    };
    let parameters = object
        .get("parameters")
        .and_then(|value| value.as_object())
        .unwrap_or(object);
    let integer = |name: &str, min: i64, max: i64| -> AppResult<Option<i64>> {
        let Some(value) = parameters.get(name) else {
            return Ok(None);
        };
        let parsed = value.as_i64().ok_or_else(|| {
            AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                format!("{name} must be an integer"),
            )
        })?;
        if !(min..=max).contains(&parsed) {
            return Err(AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                format!("{name} must be between {min} and {max}"),
            ));
        }
        Ok(Some(parsed))
    };
    let _ = integer("n", 1, 64)?;
    let _ = integer("batchSize", 1, 64)?;
    let _ = integer("seed", i64::MIN, i64::MAX)?;
    let _ = integer("frameCount", 1, 100_000)?;
    let _ = integer("firstFrameIndex", 0, 31)?;
    let _ = integer("lastFrameIndex", 0, 31)?;
    let _ = integer("continuationAssetIndex", 0, 31)?;
    let _ = integer("maskInputIndex", 0, 31)?;
    let _ = integer("steps", 1, 200)?;
    let _ = integer("scale", 1, 8)?;
    for name in ["cfgScale", "cfg_scale", "denoise"] {
        if let Some(value) = parameters.get(name) {
            let number = value.as_f64().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be numeric"),
                )
            })?;
            let range = if name == "denoise" {
                0.0..=1.0
            } else {
                0.0..=50.0
            };
            if !number.is_finite() || !range.contains(&number) {
                return Err(AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} is outside its supported range"),
                ));
            }
        }
    }
    if let Some(value) = parameters.get("fps") {
        let fps = value.as_f64().ok_or_else(|| {
            AppError::coded("MEDIA_GENERATION_PARAMETER_INVALID", "fps must be numeric")
        })?;
        if !fps.is_finite() || !(1.0..=240.0).contains(&fps) {
            return Err(AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                "fps must be between 1 and 240",
            ));
        }
    }
    for name in ["duration", "durationSeconds", "duration_seconds"] {
        if let Some(value) = parameters.get(name) {
            let duration = value.as_f64().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be numeric"),
                )
            })?;
            if !duration.is_finite() || !(0.01..=3_600.0).contains(&duration) {
                return Err(AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be between 0.01 and 3600 seconds"),
                ));
            }
        }
    }
    if let Some(value) = parameters
        .get("variantSeeds")
        .or_else(|| parameters.get("variant_seeds"))
    {
        let seeds = value.as_array().ok_or_else(|| {
            AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                "variantSeeds must be an array",
            )
        })?;
        if seeds.is_empty() || seeds.len() > 64 || seeds.iter().any(|seed| seed.as_i64().is_none())
        {
            return Err(AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                "variantSeeds must contain 1..64 integer seeds",
            ));
        }
    }
    if let Some(mode) = parameters
        .get("seedMode")
        .or_else(|| parameters.get("seed_mode"))
        .and_then(|value| value.as_str())
    {
        if !matches!(mode, "random" | "fixed" | "increment") {
            return Err(AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                "seedMode must be random, fixed, or increment",
            ));
        }
    }
    if let Some(mode) = parameters.get("frameMode").and_then(|value| value.as_str()) {
        if !matches!(mode, "single" | "firstLast" | "continue") {
            return Err(AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                "frameMode is invalid for this operation",
            ));
        }
    }
    for name in ["codec", "colorSpace", "color_space"] {
        if let Some(value) = parameters.get(name) {
            let text = value.as_str().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be a string"),
                )
            })?;
            if text.is_empty() || text.len() > 64 || text.chars().any(char::is_control) {
                return Err(AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} is invalid"),
                ));
            }
        }
    }
    for name in ["sampler", "samplerName", "sampler_name", "scheduler"] {
        if let Some(value) = parameters.get(name) {
            let text = value.as_str().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be a string"),
                )
            })?;
            if text.is_empty() || text.len() > 128 || text.chars().any(char::is_control) {
                return Err(AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} is invalid"),
                ));
            }
        }
    }
    for name in ["audio", "includeAudio", "hasAudio", "has_audio"] {
        if let Some(value) = parameters.get(name) {
            if !value.is_boolean() {
                return Err(AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be boolean"),
                ));
            }
        }
    }
    for name in [
        "partialExecutionTargets",
        "partial_execution_targets",
        "executeOutputs",
    ] {
        if let Some(value) = parameters.get(name) {
            let targets = value.as_array().ok_or_else(|| {
                AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must be an array"),
                )
            })?;
            if targets.is_empty()
                || targets.len() > 256
                || targets.iter().any(|target| {
                    target.as_str().is_none_or(|text| {
                        text.is_empty() || text.len() > 128 || text.chars().any(char::is_control)
                    }) && target.as_i64().is_none()
                })
            {
                return Err(AppError::coded(
                    "MEDIA_GENERATION_PARAMETER_INVALID",
                    format!("{name} must contain 1..256 node ids"),
                ));
            }
        }
    }
    Ok(())
}

/// Validate the relationship between a role-bearing staged asset and the
/// provider parameters that refer to it. The index is intentionally checked
/// after loading the run inputs, because a JSON-only range check cannot catch a
/// mask pointing at a different workspace asset or at a removed input.
fn validate_input_role_parameters(
    request: &serde_json::Value,
    input_assets: &[MediaAsset],
) -> AppResult<()> {
    let Some(object) = request.as_object() else {
        return Ok(());
    };
    let parameters = object
        .get("parameters")
        .and_then(|value| value.as_object())
        .unwrap_or(object);
    let Some(raw_index) = parameters
        .get("maskInputIndex")
        .or_else(|| parameters.get("mask_input_index"))
    else {
        return Ok(());
    };
    let index = raw_index.as_i64().ok_or_else(|| {
        AppError::coded(
            "MEDIA_GENERATION_PARAMETER_INVALID",
            "maskInputIndex must be an integer",
        )
    })?;
    if index < 0 || index as usize >= input_assets.len() {
        return Err(AppError::coded(
            "MEDIA_GENERATION_PARAMETER_INVALID",
            "maskInputIndex does not reference an input asset",
        ));
    }
    if let Some(role) = input_assets[index as usize]
        .metadata
        .get("role")
        .or_else(|| input_assets[index as usize].metadata.get("assetRole"))
        .and_then(|value| value.as_str())
    {
        if role != "mask" {
            return Err(AppError::coded(
                "MEDIA_GENERATION_PARAMETER_INVALID",
                "maskInputIndex must reference an asset marked as a mask",
            ));
        }
    }
    Ok(())
}

fn validate_provider_ref(provider: Option<&MediaProviderRef>) -> AppResult<()> {
    if let Some(provider) = provider {
        validate_id(&provider.provider_id, "providerId")?;
        validate_id(&provider.model_id, "modelId")?;
    }
    Ok(())
}

fn validate_client_request_id(value: Option<&str>) -> AppResult<()> {
    if let Some(value) = value {
        if value.trim().is_empty() || value.len() > 256 {
            return Err(AppError::coded(
                "MEDIA_CLIENT_REQUEST_ID_INVALID",
                "clientRequestId is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_relative_media_path(value: &str) -> AppResult<()> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains(':')
        || value.contains('\\')
    {
        return Err(AppError::coded(
            "MEDIA_PATH_INVALID",
            "asset path is invalid",
        ));
    }
    let valid = value.split('/').all(|component| {
        !component.is_empty()
            && component != "."
            && component != ".."
            && component
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    });
    if !valid {
        return Err(AppError::coded(
            "MEDIA_PATH_INVALID",
            "asset path is invalid",
        ));
    }
    Ok(())
}

fn is_safe_media_extension(value: &str) -> bool {
    let value = value.trim().trim_start_matches('.');
    matches!(
        value.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "mp4" | "m4v" | "webm" | "mov" | "mkv"
    )
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn mime_extension(mime_type: &str) -> &'static str {
    match mime_type.split(';').next().unwrap_or(mime_type).trim() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-matroska" => "mkv",
        _ => "bin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CreateMediaAssetRequest, CreateMediaNodeRequest, CreateMediaRunRequest, MediaCachePolicy,
        ReplayMediaRunRequest, StageMediaInputRequest,
    };
    use crate::repository::Database;
    use crate::services::WorkspaceService;

    fn service() -> MediaService {
        let db = Arc::new(Database::new_in_memory().expect("database"));
        MediaService::new(Arc::new(MediaRepository::new(db)))
    }

    #[test]
    fn project_scope_controls_image_and_video_asset_roots_and_isolates_projects() {
        let workspace_root = tempfile::tempdir().expect("workspace registry root");
        let project_parent = tempfile::tempdir().expect("project parent");
        let project_a_path = project_parent.path().join("project-a");
        let project_b_path = project_parent.path().join("project-b");
        std::fs::create_dir_all(&project_a_path).expect("project a");
        std::fs::create_dir_all(&project_b_path).expect("project b");
        let app_media_root = tempfile::tempdir().expect("application media root");
        let workspace_service =
            Arc::new(WorkspaceService::new(workspace_root.path().to_path_buf()));
        let workspace = workspace_service
            .create_workspace("media-scope", None)
            .expect("workspace");
        let project_a = workspace_service
            .add_project("media-scope", &project_a_path.to_string_lossy())
            .expect("project a registration");
        let project_b = workspace_service
            .add_project("media-scope", &project_b_path.to_string_lossy())
            .expect("project b registration");
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().expect("database"),
            ))),
            app_media_root.path().to_path_buf(),
        );
        service.set_workspace_service(workspace_service);

        let scope_for = |project_id: &str, project_path: &std::path::Path| {
            serde_json::json!({
                "workspaceId": workspace.id,
                "projectId": project_id,
                // The path is intentionally present only as display metadata;
                // the service resolves the actual path from the registry.
                "projectPath": project_path.to_string_lossy(),
            })
        };
        let stage = |project_id: &str, project_path: &std::path::Path, filename: &str| {
            service
                .stage_input(StageMediaInputRequest {
                    workspace_id: workspace.id.clone(),
                    filename: filename.to_string(),
                    mime_type: "image/png".to_string(),
                    data: base64::engine::general_purpose::STANDARD.encode([1_u8, 2, 3]),
                    metadata: Some(serde_json::json!({
                        "role": "reference",
                        "mediaScope": scope_for(project_id, project_path),
                    })),
                })
                .expect("stage scoped input")
        };

        let asset_a = stage(&project_a.id, &project_a_path, "reference-a.png");
        let asset_b = stage(&project_b.id, &project_b_path, "reference-b.png");
        let project_media_root_a = project_a_path.join(".ccpanes").join("media");
        let project_media_root_b = project_b_path.join(".ccpanes").join("media");
        let asset_path_a = project_media_root_a.join(&asset_a.relative_path);
        let asset_path_b = project_media_root_b.join(&asset_b.relative_path);
        assert!(asset_path_a.is_file());
        assert!(asset_path_b.is_file());
        assert!(!app_media_root.path().join(&asset_a.relative_path).exists());
        assert!(!app_media_root.path().join(&asset_b.relative_path).exists());
        assert_eq!(
            dunce::canonicalize(service.resolve_asset_path(&asset_a.id).expect("resolve a"))
                .expect("canonical a"),
            dunce::canonicalize(&asset_path_a).expect("canonical asset a"),
        );

        let image_scope = scope_for(&project_a.id, &project_a_path);
        let image_node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: workspace.id.clone(),
                layout_id: format!("media-{}-{}", workspace.id, project_a.id),
                kind: MediaKind::Image,
                title: "Scoped image".to_string(),
                default_operation: Some(MediaOperation::TextToImage),
                provider_ref: Some(MediaProviderRef {
                    provider_id: "provider-image".to_string(),
                    model_id: "model-image".to_string(),
                }),
                parameters: Some(serde_json::json!({"mediaScope": image_scope.clone()})),
            })
            .expect("scoped image node");
        let image_run = service
            .create_run(CreateMediaRunRequest {
                node_id: image_node.id.clone(),
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({
                    "prompt": "scoped image",
                    "parameters": {"mediaScope": image_scope.clone()},
                }),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .expect("scoped image run");
        let output_a = service
            .persist_provider_output(
                &image_run.id,
                &MediaProviderOutput {
                    bytes: vec![137, 80, 78, 71],
                    mime_type: "image/png".to_string(),
                    extension: Some("png".to_string()),
                    sha256: None,
                    width: Some(32),
                    height: Some(32),
                    duration_ms: None,
                    metadata: serde_json::json!({}),
                },
            )
            .expect("scoped image output");
        assert_eq!(output_a.metadata[MEDIA_STORAGE_KEY], "project");
        assert!(project_media_root_a.join(&output_a.relative_path).is_file());
        assert!(!app_media_root.path().join(&output_a.relative_path).exists());

        let video_node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: workspace.id.clone(),
                layout_id: format!("media-{}-{}", workspace.id, project_a.id),
                kind: MediaKind::Video,
                title: "Scoped video".to_string(),
                default_operation: Some(MediaOperation::TextToVideo),
                provider_ref: Some(MediaProviderRef {
                    provider_id: "provider-video".to_string(),
                    model_id: "model-video".to_string(),
                }),
                parameters: Some(serde_json::json!({"mediaScope": image_scope.clone()})),
            })
            .expect("scoped video node");
        let video_run = service
            .create_run(CreateMediaRunRequest {
                node_id: video_node.id,
                operation: MediaOperation::TextToVideo,
                request: serde_json::json!({
                    "prompt": "scoped video",
                    "parameters": {"mediaScope": image_scope},
                }),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .expect("scoped video run");
        let output_video = service
            .persist_provider_output(
                &video_run.id,
                &MediaProviderOutput {
                    bytes: vec![0, 1, 2, 3],
                    mime_type: "video/mp4".to_string(),
                    extension: Some("mp4".to_string()),
                    sha256: None,
                    width: Some(320),
                    height: Some(180),
                    duration_ms: Some(1000),
                    metadata: serde_json::json!({}),
                },
            )
            .expect("scoped video output");
        assert_eq!(output_video.metadata[MEDIA_STORAGE_KEY], "project");
        assert!(project_media_root_a
            .join(&output_video.relative_path)
            .is_file());
        assert!(!app_media_root
            .path()
            .join(&output_video.relative_path)
            .exists());

        // A node bound to project A cannot consume a staged asset from project B,
        // even though both assets belong to the same workspace.
        let error = service
            .create_run(CreateMediaRunRequest {
                node_id: image_node.id,
                operation: MediaOperation::ImageToImage,
                request: serde_json::json!({
                    "prompt": "wrong project",
                    "parameters": {"mediaScope": image_scope},
                }),
                client_request_id: None,
                input_asset_ids: vec![asset_b.id],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .expect_err("cross-project input must fail");
        assert_eq!(error.code(), Some("MEDIA_PROJECT_MISMATCH"));
    }

    #[test]
    fn stage_input_writes_controlled_asset_and_registers_hash() {
        let root = tempfile::tempdir().expect("media root");
        let db = Arc::new(Database::new_in_memory().expect("database"));
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(db)),
            root.path().to_path_buf(),
        );
        let asset = service
            .stage_input(StageMediaInputRequest {
                workspace_id: "ws".to_string(),
                filename: "reference.png".to_string(),
                mime_type: "image/png".to_string(),
                data: base64::engine::general_purpose::STANDARD.encode([1_u8, 2, 3]),
                metadata: Some(serde_json::json!({"role": "mask"})),
            })
            .expect("stage input");
        assert_eq!(asset.mime_type, "image/png");
        assert_eq!(asset.metadata["role"], "mask");
        assert_eq!(asset.metadata["source"], "user-input");
        assert!(asset.relative_path.starts_with("ws/"));
        assert_eq!(
            std::fs::read(root.path().join(&asset.relative_path)).unwrap(),
            [1, 2, 3]
        );
        assert!(asset.sha256.is_some());
    }

    #[test]
    fn stage_input_accepts_comfy_mkv_video_container() {
        let root = tempfile::tempdir().expect("media root");
        let db = Arc::new(Database::new_in_memory().expect("database"));
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(db)),
            root.path().to_path_buf(),
        );
        let asset = service
            .stage_input(StageMediaInputRequest {
                workspace_id: "ws".to_string(),
                filename: "reference.mkv".to_string(),
                mime_type: "video/x-matroska".to_string(),
                data: base64::engine::general_purpose::STANDARD.encode([1_u8, 2, 3]),
                metadata: None,
            })
            .expect("stage mkv input");
        assert_eq!(asset.mime_type, "video/x-matroska");
        assert!(asset.relative_path.ends_with(".mkv"));
    }

    #[test]
    fn provider_output_accepts_comfy_mkv_video_container() {
        let root = tempfile::tempdir().expect("media root");
        let db = Arc::new(Database::new_in_memory().expect("database"));
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(db)),
            root.path().to_path_buf(),
        );
        let node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".to_string(),
                layout_id: "layout".to_string(),
                kind: MediaKind::Video,
                title: "Video".to_string(),
                default_operation: Some(MediaOperation::TextToVideo),
                provider_ref: Some(MediaProviderRef {
                    provider_id: "comfy".to_string(),
                    model_id: "workflow".to_string(),
                }),
                parameters: None,
            })
            .expect("video node");
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id.clone(),
                operation: MediaOperation::TextToVideo,
                request: serde_json::json!({"prompt": "test"}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .expect("video run");
        let asset = service
            .persist_provider_output(
                &run.id,
                &MediaProviderOutput {
                    bytes: vec![1, 2, 3, 4],
                    mime_type: "video/x-matroska".to_string(),
                    extension: Some("mkv".to_string()),
                    sha256: None,
                    width: Some(320),
                    height: Some(240),
                    duration_ms: Some(1000),
                    metadata: serde_json::json!({"codec": "h264"}),
                },
            )
            .expect("persist mkv output");
        assert_eq!(asset.mime_type, "video/x-matroska");
        assert!(asset.relative_path.ends_with(".mkv"));
        assert_eq!(asset.width, Some(320));
        assert_eq!(asset.height, Some(240));
        assert_eq!(asset.duration_ms, Some(1000));
        assert_eq!(asset.metadata["codec"], "h264");
    }

    #[test]
    fn provider_metadata_backfills_video_fields_and_generation_parameters() {
        let root = tempfile::tempdir().unwrap();
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().unwrap(),
            ))),
            root.path().to_path_buf(),
        );
        let node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".into(),
                layout_id: "layout".into(),
                kind: MediaKind::Video,
                title: "Metadata video".into(),
                default_operation: Some(MediaOperation::TextToVideo),
                provider_ref: Some(MediaProviderRef {
                    provider_id: "p".into(),
                    model_id: "m".into(),
                }),
                parameters: None,
            })
            .unwrap();
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToVideo,
                request: serde_json::json!({
                    "prompt": "a shot",
                    "parameters": {"seed": 42, "fps": 30, "audio": true}
                }),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .unwrap();
        let asset = service
            .persist_provider_output(
                &run.id,
                &MediaProviderOutput {
                    bytes: vec![1, 2, 3],
                    mime_type: "video/mp4".into(),
                    extension: Some("mp4".into()),
                    sha256: None,
                    width: None,
                    height: None,
                    duration_ms: None,
                    metadata: serde_json::json!({
                        "video_width": 640,
                        "video_height": 360,
                        "durationSeconds": 2.5,
                        "frame_rate": 30,
                        "has_audio": true,
                        "video_codec": "h264",
                        "color_space": "bt709"
                    }),
                },
            )
            .unwrap();
        assert_eq!(asset.width, Some(640));
        assert_eq!(asset.height, Some(360));
        assert_eq!(asset.duration_ms, Some(2500));
        assert_eq!(asset.metadata["fps"], 30.0);
        assert_eq!(asset.metadata["audio"], true);
        assert_eq!(asset.metadata["codec"], "h264");
        assert_eq!(asset.metadata["colorSpace"], "bt709");
        assert_eq!(asset.metadata["seed"], 42);
        assert_eq!(asset.metadata["prompt"], "a shot");
    }

    #[test]
    fn unavailable_probe_is_recorded_without_discarding_provider_metadata() {
        let root = tempfile::tempdir().unwrap();
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().unwrap(),
            ))),
            root.path().to_path_buf(),
        )
        .with_media_probe(MediaProbe::new(
            crate::services::media_probe::MediaProbeConfig::default()
                .with_executable("cc-panes-no-such-ffprobe"),
        ));
        let node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".into(),
                layout_id: "layout".into(),
                kind: MediaKind::Video,
                title: "Probe fallback".into(),
                default_operation: Some(MediaOperation::TextToVideo),
                provider_ref: None,
                parameters: None,
            })
            .unwrap();
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToVideo,
                request: serde_json::json!({"parameters": {"fps": 24}}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .unwrap();
        let asset = service
            .persist_provider_output(
                &run.id,
                &MediaProviderOutput {
                    bytes: vec![1, 2, 3],
                    mime_type: "video/mp4".into(),
                    extension: Some("mp4".into()),
                    sha256: None,
                    width: None,
                    height: None,
                    duration_ms: None,
                    metadata: serde_json::json!({"width": 640, "height": 360}),
                },
            )
            .unwrap();
        assert_eq!(asset.width, Some(640));
        assert_eq!(asset.height, Some(360));
        assert_eq!(asset.metadata["probeStatus"], "unavailable");
        assert_eq!(
            asset.metadata["probeReason"],
            "ffprobe executable is unavailable"
        );
    }

    #[test]
    fn probe_values_replace_conflicts_and_keep_a_diagnostic_record() {
        let mut metadata = serde_json::json!({"width": 640, "audio": true});
        let report = MediaProbeReport {
            status: crate::services::media_probe::MediaProbeStatus::Ok,
            tool: Some("ffprobe".into()),
            reason: None,
            container: Some("mov,mp4,m4a,3gp,3g2,mj2".into()),
            width: Some(1280),
            height: Some(720),
            duration_ms: Some(1000),
            fps: Some(30.0),
            frame_count: Some(30),
            audio: Some(false),
            codec: Some("h264".into()),
            audio_codec: None,
            audio_channels: None,
            sample_rate: None,
            color_space: Some("bt709".into()),
            color_transfer: None,
            color_primaries: None,
            pixel_format: None,
            bit_depth: None,
        };
        let dimensions = apply_probe_report(&mut metadata, &report, None, None, None);
        assert_eq!(dimensions, (Some(1280), Some(720), Some(1000)));
        assert_eq!(metadata["width"], 1280);
        assert_eq!(metadata["audio"], false);
        assert_eq!(metadata["probeStatus"], "ok");
        assert_eq!(metadata["probeConflicts"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn video_run_accepts_a_marked_image_poster_asset() {
        let root = tempfile::tempdir().unwrap();
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().unwrap(),
            ))),
            root.path().to_path_buf(),
        );
        let node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".into(),
                layout_id: "layout".into(),
                kind: MediaKind::Video,
                title: "Poster video".into(),
                default_operation: Some(MediaOperation::TextToVideo),
                provider_ref: Some(MediaProviderRef {
                    provider_id: "p".into(),
                    model_id: "m".into(),
                }),
                parameters: None,
            })
            .unwrap();
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToVideo,
                request: serde_json::json!({}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .unwrap();
        let asset = service
            .persist_provider_output(
                &run.id,
                &MediaProviderOutput {
                    bytes: vec![137, 80, 78, 71],
                    mime_type: "image/png".into(),
                    extension: Some("png".into()),
                    sha256: None,
                    width: Some(640),
                    height: Some(360),
                    duration_ms: None,
                    metadata: serde_json::json!({"role": "poster"}),
                },
            )
            .unwrap();
        assert_eq!(asset.metadata["role"], "poster");
        assert_eq!(service.list_assets("ws", Some(&run.id)).unwrap().len(), 1);
    }

    fn image_node(service: &MediaService) -> MediaNode {
        service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".to_string(),
                layout_id: "layout".to_string(),
                kind: MediaKind::Image,
                title: "Poster".to_string(),
                default_operation: None,
                provider_ref: Some(MediaProviderRef {
                    provider_id: "sub2api".to_string(),
                    model_id: "image-model".to_string(),
                }),
                parameters: None,
            })
            .unwrap()
    }

    #[test]
    fn create_run_is_idempotent_for_same_request() {
        let service = service();
        let node = image_node(&service);
        let request = CreateMediaRunRequest {
            node_id: node.id.clone(),
            operation: MediaOperation::TextToImage,
            request: serde_json::json!({"prompt":"hello"}),
            client_request_id: Some("client-1".to_string()),
            input_asset_ids: vec![],
            priority: None,
            cache_policy: None,
        };
        let first = service.create_run(request.clone()).unwrap();
        let second = service.create_run(request).unwrap();
        assert_eq!(first.id, second.id);
    }

    #[test]
    fn generation_parameter_bounds_are_enforced_before_queueing() {
        let service = service();
        let node = image_node(&service);
        let error = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id.clone(),
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({"parameters": {"n": 65, "seedMode": "bad"}}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_GENERATION_PARAMETER_INVALID"));

        let error = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({"parameters": {"audio": "yes"}}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_GENERATION_PARAMETER_INVALID"));
    }

    #[test]
    fn mask_input_index_must_reference_a_mask_role() {
        let reference = MediaAsset {
            id: "reference".into(),
            workspace_id: "ws".into(),
            run_id: None,
            relative_path: "ws/reference.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 1,
            sha256: None,
            width: None,
            height: None,
            duration_ms: None,
            metadata: serde_json::json!({"role": "reference"}),
            created_at: now(),
        };
        let mask = MediaAsset {
            metadata: serde_json::json!({"role": "mask"}),
            id: "mask".into(),
            relative_path: "ws/mask.png".into(),
            ..reference.clone()
        };
        assert!(validate_input_role_parameters(
            &serde_json::json!({"parameters": {"maskInputIndex": 1}}),
            &[reference.clone(), mask],
        )
        .is_ok());
        let error = validate_input_role_parameters(
            &serde_json::json!({"parameters": {"maskInputIndex": 0}}),
            &[reference],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_GENERATION_PARAMETER_INVALID"));
    }

    #[test]
    fn replay_run_merges_parameters_and_ignores_lineage_for_fingerprint() {
        let service = service();
        let node = image_node(&service);
        let source = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({
                    "prompt": "original",
                    "parameters": {"seed": 10, "quality": "hd"}
                }),
                client_request_id: Some("source-run".into()),
                input_asset_ids: vec![],
                priority: Some(3),
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .unwrap();
        let variant = service
            .replay_run(
                &source.id,
                ReplayMediaRunRequest {
                    prompt: Some("variant".into()),
                    parameters: Some(serde_json::json!({"seed": 11})),
                    priority: None,
                    cache_policy: None,
                    input_asset_ids: None,
                    client_request_id: Some("variant-run".into()),
                },
            )
            .unwrap();
        assert_ne!(variant.id, source.id);
        assert_eq!(variant.priority, 3);
        assert_eq!(variant.cache_policy, MediaCachePolicy::Bypass);
        assert_eq!(variant.request["prompt"], "variant");
        assert_eq!(variant.request["parameters"]["seed"], 11);
        assert_eq!(variant.request["parameters"]["quality"], "hd");
        assert_eq!(variant.request["replayOfRunId"], source.id);

        let mut with_lineage = variant.request.clone();
        with_lineage
            .as_object_mut()
            .unwrap()
            .insert("replayOfRunId".into(), serde_json::json!("different"));
        let node = service.get_node(&variant.node_id).unwrap().unwrap();
        let request = |value| CreateMediaRunRequest {
            node_id: variant.node_id.clone(),
            operation: variant.operation,
            request: value,
            client_request_id: None,
            input_asset_ids: vec![],
            priority: None,
            cache_policy: None,
        };
        assert_eq!(
            execution_fingerprint_with_provider_config(&node, &request(with_lineage), &[], None)
                .unwrap(),
            execution_fingerprint_with_provider_config(
                &node,
                &request(variant.request.clone()),
                &[],
                None,
            )
            .unwrap()
        );
    }

    #[test]
    fn replay_run_preserves_legacy_top_level_parameters() {
        let service = service();
        let node = image_node(&service);
        let source = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({
                    "prompt": "legacy",
                    "size": "1536x1024",
                    "n": 2,
                    "providerProtocol": "open_ai_compatible"
                }),
                client_request_id: Some("legacy-source".into()),
                input_asset_ids: vec![],
                priority: None,
                cache_policy: Some(MediaCachePolicy::Bypass),
            })
            .unwrap();
        let variant = service
            .replay_run(
                &source.id,
                ReplayMediaRunRequest {
                    parameters: Some(serde_json::json!({"n": 4, "seed": 99})),
                    client_request_id: Some("legacy-variant".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(variant.request["size"], "1536x1024");
        assert_eq!(variant.request["n"], 4);
        assert_eq!(variant.request["seed"], 99);
        assert_eq!(variant.request["providerProtocol"], "open_ai_compatible");
    }

    #[test]
    fn replay_run_rejects_non_object_parameter_override() {
        let service = service();
        let node = image_node(&service);
        let source = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({"prompt": "legacy"}),
                client_request_id: Some("invalid-override-source".into()),
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        let error = service
            .replay_run(
                &source.id,
                ReplayMediaRunRequest {
                    parameters: Some(serde_json::json!(["not", "an", "object"])),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_PARAMETERS_INVALID"));
    }

    #[test]
    fn execution_fingerprint_uses_content_hash_over_asset_path() {
        let service = service();
        let node = image_node(&service);
        let request = CreateMediaRunRequest {
            node_id: node.id.clone(),
            operation: MediaOperation::ImageToImage,
            request: serde_json::json!({"prompt": "same"}),
            client_request_id: None,
            input_asset_ids: vec![],
            priority: None,
            cache_policy: None,
        };
        let first = MediaAsset {
            id: "asset-a".to_string(),
            workspace_id: "ws".to_string(),
            run_id: None,
            relative_path: "ws/first.png".to_string(),
            mime_type: "image/png".to_string(),
            size_bytes: 4,
            sha256: Some("a".repeat(64)),
            width: Some(2),
            height: Some(2),
            duration_ms: None,
            metadata: serde_json::json!({}),
            created_at: now(),
        };
        let mut second = first.clone();
        second.id = "asset-b".to_string();
        second.relative_path = "ws/renamed.png".to_string();
        assert_eq!(
            execution_fingerprint_with_provider_config(&node, &request, &[first], None).unwrap(),
            execution_fingerprint_with_provider_config(&node, &request, &[second], None).unwrap(),
        );
    }

    #[test]
    fn cache_hit_reuses_output_and_lists_it_for_the_new_run() {
        let root = tempfile::tempdir().expect("media root");
        let db = Arc::new(Database::new_in_memory().expect("database"));
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(db)),
            root.path().to_path_buf(),
        );
        let node = image_node(&service);
        let request = serde_json::json!({"prompt": "same prompt"});
        let first = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id.clone(),
                operation: MediaOperation::TextToImage,
                request: request.clone(),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        service
            .transition_run(&first.id, MediaRunStatus::Submitting, Some(1), None, None)
            .unwrap();
        service
            .transition_run(&first.id, MediaRunStatus::Processing, Some(40), None, None)
            .unwrap();
        service
            .transition_run(&first.id, MediaRunStatus::Downloading, Some(90), None, None)
            .unwrap();
        let asset = service
            .persist_provider_output(
                &first.id,
                &MediaProviderOutput {
                    bytes: vec![1, 2, 3, 4],
                    mime_type: "image/png".to_string(),
                    extension: Some("png".to_string()),
                    sha256: None,
                    width: Some(2),
                    height: Some(2),
                    duration_ms: None,
                    metadata: serde_json::json!({}),
                },
            )
            .unwrap();
        let succeeded = service
            .transition_run(&first.id, MediaRunStatus::Succeeded, Some(100), None, None)
            .unwrap();
        service.register_cache(&succeeded).unwrap();

        let cached = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request,
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        assert_eq!(cached.status, MediaRunStatus::Succeeded);
        assert!(cached.cache_hit);
        assert_eq!(cached.output_asset_ids, vec![asset.id.clone()]);
        let listed = service.list_assets("ws", Some(&cached.id)).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [asset.id.as_str()]
        );
    }

    #[test]
    fn provider_config_fingerprint_partitions_media_cache() {
        let root = tempfile::tempdir().expect("media root");
        let db = Arc::new(Database::new_in_memory().expect("database"));
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(db)),
            root.path().to_path_buf(),
        );
        let node = image_node(&service);
        let request = serde_json::json!({"prompt": "same prompt"});
        let first_config = "a".repeat(64);
        let changed_config = "b".repeat(64);
        let create = |config: &str| {
            service.create_run_with_provider_config_fingerprint(
                CreateMediaRunRequest {
                    node_id: node.id.clone(),
                    operation: MediaOperation::TextToImage,
                    request: request.clone(),
                    client_request_id: None,
                    input_asset_ids: vec![],
                    priority: None,
                    cache_policy: None,
                },
                Some(config),
            )
        };

        let first = create(&first_config).expect("first run");
        service
            .transition_run(&first.id, MediaRunStatus::Submitting, Some(1), None, None)
            .expect("submitting");
        service
            .transition_run(&first.id, MediaRunStatus::Processing, Some(40), None, None)
            .expect("processing");
        service
            .transition_run(&first.id, MediaRunStatus::Downloading, Some(90), None, None)
            .expect("downloading");
        service
            .persist_provider_output(
                &first.id,
                &MediaProviderOutput {
                    bytes: vec![1, 2, 3, 4],
                    mime_type: "image/png".to_string(),
                    extension: Some("png".to_string()),
                    sha256: None,
                    width: Some(2),
                    height: Some(2),
                    duration_ms: None,
                    metadata: serde_json::json!({}),
                },
            )
            .expect("output");
        let succeeded = service
            .transition_run(&first.id, MediaRunStatus::Succeeded, Some(100), None, None)
            .expect("succeeded");
        service.register_cache(&succeeded).expect("cache");

        let matching = create(&first_config).expect("matching config");
        assert!(matching.cache_hit);
        let changed = create(&changed_config).expect("changed config");
        assert!(!changed.cache_hit);
        assert_eq!(changed.status, MediaRunStatus::Queued);
    }

    #[test]
    fn queued_runs_are_claimed_by_priority_before_age() {
        let service = service();
        let node = image_node(&service);
        for (priority, prompt) in [(0, "old"), (10, "high"), (-5, "low")] {
            service
                .create_run(CreateMediaRunRequest {
                    node_id: node.id.clone(),
                    operation: MediaOperation::TextToImage,
                    request: serde_json::json!({"prompt": prompt}),
                    client_request_id: None,
                    input_asset_ids: vec![],
                    priority: Some(priority),
                    cache_policy: Some(MediaCachePolicy::Bypass),
                })
                .unwrap();
        }
        let first = service
            .claim_next_run("priority-worker", chrono::Duration::seconds(30))
            .unwrap()
            .unwrap();
        assert_eq!(first.priority, 10);
        let second = service
            .claim_next_run("priority-worker", chrono::Duration::seconds(30))
            .unwrap()
            .unwrap();
        assert_eq!(second.priority, 0);
    }

    #[test]
    fn state_machine_rejects_terminal_to_processing_and_allows_retry() {
        let service = service();
        let node = image_node(&service);
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        service
            .transition_run(&run.id, MediaRunStatus::Submitting, Some(1), None, None)
            .unwrap();
        service
            .transition_run(
                &run.id,
                MediaRunStatus::Failed,
                None,
                Some("PROVIDER_ERROR".to_string()),
                Some("failed".to_string()),
            )
            .unwrap();
        assert!(service
            .transition_run(&run.id, MediaRunStatus::Processing, None, None, None)
            .is_err());
        let retried = service.retry_run(&run.id).unwrap();
        assert_eq!(retried.status, MediaRunStatus::Queued);
        assert_eq!(retried.attempt, 2);
    }

    #[test]
    fn operation_kind_and_edge_scope_are_validated() {
        let service = service();
        let node = image_node(&service);
        let bad = service.create_run(CreateMediaRunRequest {
            node_id: node.id.clone(),
            operation: MediaOperation::TextToVideo,
            request: serde_json::json!({}),
            client_request_id: None,
            input_asset_ids: vec![],
            priority: None,
            cache_policy: None,
        });
        assert_eq!(
            bad.unwrap_err().code(),
            Some("MEDIA_OPERATION_KIND_MISMATCH")
        );
    }

    #[test]
    fn asset_path_rejects_absolute_and_parent_components() {
        assert!(validate_relative_media_path("ws/a1.png").is_ok());
        assert!(validate_relative_media_path("../a1.png").is_err());
        assert!(validate_relative_media_path("ws/../a1.png").is_err());
        assert!(validate_relative_media_path("C:/a1.png").is_err());
        assert!(validate_relative_media_path(r"ws\a1.png").is_err());
    }

    #[test]
    fn input_asset_scope_and_kind_are_enforced() {
        let service = service();
        let node = image_node(&service);
        let asset = service
            .create_asset(CreateMediaAssetRequest {
                workspace_id: "ws".into(),
                run_id: None,
                relative_path: "ws/video.mp4".into(),
                mime_type: "video/mp4".into(),
                size_bytes: 1,
                sha256: None,
                width: None,
                height: None,
                duration_ms: None,
                metadata: None,
            })
            .unwrap();
        let error = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::ImageToImage,
                request: serde_json::json!({}),
                client_request_id: None,
                input_asset_ids: vec![asset.id],
                priority: None,
                cache_policy: None,
            })
            .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_INPUT_KIND_MISMATCH"));
        assert!(service
            .create_asset(CreateMediaAssetRequest {
                workspace_id: "ws".into(),
                run_id: None,
                relative_path: "other/asset.png".into(),
                mime_type: "image/png".into(),
                size_bytes: 1,
                sha256: None,
                width: None,
                height: None,
                duration_ms: None,
                metadata: None,
            })
            .is_err());
    }

    #[test]
    fn provider_output_hash_mismatch_does_not_register_an_asset() {
        let root = tempfile::tempdir().unwrap();
        let service = MediaService::with_media_root(
            Arc::new(MediaRepository::new(Arc::new(
                Database::new_in_memory().unwrap(),
            ))),
            root.path().to_path_buf(),
        );
        let node = image_node(&service);
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        let error = service
            .persist_provider_output(
                &run.id,
                &MediaProviderOutput {
                    bytes: b"not-a-real-image".to_vec(),
                    mime_type: "image/png".into(),
                    extension: Some("png".into()),
                    sha256: Some(
                        "0000000000000000000000000000000000000000000000000000000000000000".into(),
                    ),
                    width: None,
                    height: None,
                    duration_ms: None,
                    metadata: serde_json::json!({}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_HASH_MISMATCH"));
        assert!(service.list_assets("ws", Some(&run.id)).unwrap().is_empty());
    }

    #[test]
    fn leased_transition_rejects_a_different_owner() {
        let service = service();
        let node = image_node(&service);
        let run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        let claimed = service
            .claim_next_run("owner-a", chrono::Duration::seconds(30))
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, run.id);
        let error = service
            .transition_run_for_owner(
                &run.id,
                "owner-b",
                MediaRunStatus::Processing,
                Some(10),
                None,
                None,
            )
            .unwrap_err();
        assert_eq!(error.code(), Some("MEDIA_LEASE_LOST"));
    }

    #[test]
    fn provider_events_update_progress_monotonically_without_terminal_transition() {
        let service = service();
        let node = service
            .create_node(CreateMediaNodeRequest {
                workspace_id: "ws".to_string(),
                layout_id: "layout".to_string(),
                kind: MediaKind::Image,
                title: "Comfy".to_string(),
                default_operation: None,
                provider_ref: Some(MediaProviderRef {
                    provider_id: "comfy".to_string(),
                    model_id: "workflow".to_string(),
                }),
                parameters: None,
            })
            .unwrap();
        let _run = service
            .create_run(CreateMediaRunRequest {
                node_id: node.id,
                operation: MediaOperation::TextToImage,
                request: serde_json::json!({}),
                client_request_id: None,
                input_asset_ids: vec![],
                priority: None,
                cache_policy: None,
            })
            .unwrap();
        let claimed = service
            .claim_next_run("event-owner", chrono::Duration::seconds(30))
            .unwrap()
            .unwrap();
        service
            .record_remote_job(
                &claimed.id,
                "event-owner",
                "prompt-1",
                MediaRunStatus::Processing,
                Some(0),
            )
            .unwrap();
        let updated = service
            .apply_provider_event("comfy", "prompt-1", Some(42), None, None)
            .unwrap()
            .unwrap();
        assert_eq!(updated.progress, Some(42));
        let unchanged = service
            .apply_provider_event(
                "comfy",
                "prompt-1",
                Some(12),
                Some("COMFY_NODE"),
                Some("node"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.progress, Some(42));
        assert_eq!(unchanged.status, MediaRunStatus::Processing);
        assert_eq!(unchanged.error_code.as_deref(), Some("COMFY_NODE"));
    }
}
