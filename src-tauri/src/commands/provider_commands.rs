use crate::models::provider::Provider;
use crate::services::ProviderService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn list_providers(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Vec<Provider>> {
    Ok(service.list_providers())
}

#[tauri::command]
pub fn get_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Option<Provider>> {
    Ok(service.get_provider(&id))
}

#[tauri::command]
pub fn get_default_provider(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Option<Provider>> {
    Ok(service.get_default_provider())
}

#[tauri::command]
pub fn add_provider(
    provider: Provider,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    Ok(service.add_provider(provider)?)
}

#[tauri::command]
pub fn update_provider(
    provider: Provider,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    Ok(service.update_provider(provider)?)
}

#[tauri::command]
pub fn remove_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    Ok(service.remove_provider(&id)?)
}

#[tauri::command]
pub fn set_default_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    Ok(service.set_default(&id)?)
}
