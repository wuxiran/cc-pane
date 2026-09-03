//! CC-Panes Provider → dsh `llm-pi-ai` 路由映射
//!
//! dsh 的模型路由由 `llm-pi-ai` 插件承担，配置形状是
//! `llm-pi-ai.providers.<route>`，我们经 **patch 层**改那一行而不是写
//! `settings.yaml`——后者是 dsh 自己的可读写状态文件（存 `ui-onboarding` 等
//! 用户设置），整份覆盖会把用户在 dsh UI 里改的东西抹掉。
//!
//! 两条它自己定死的规矩决定了本模块的写法：
//!
//! 1. **配置只存凭据引用，不存密钥**（`apiKeyEnv: FOO_API_KEY`）。密钥走凭据层，
//!    而进程环境是凭据层里优先级最高的一层。所以我们把 key 走 env 注入，
//!    settings 里只留引用名——用户在 CC-Panes 配一次，所有标签都生效，
//!    不必每开一个新标签在 dsh 自己的 Models 页重填。
//! 2. **手工声明的路由必须自带 `models` 列表**（pi-ai 没有这个 key 的目录），
//!    且「声明了 models 就得列全」。没有模型的 Provider 因此不生成路由——
//!    生成一个空路由只会让请求以 `UNKNOWN_MODEL` 失败，不如不出现。

use crate::models::provider::{Provider, ProviderType, SYSTEM_PROVIDER_ID};

/// 一个 Provider 映射出来的东西：一条路由 + 要注入的 env。
pub(super) struct MappedProvider {
    /// 路由名（`providers` 字典的键）
    pub route: String,
    /// 该路由的配置对象
    pub config: serde_json::Value,
    /// 该路由的凭据 env（名字与 `apiKeyEnv` 一致）
    pub env: Option<(String, String)>,
}

/// dsh 的 route id 约束：小写。用 Provider id 派生，非法字符折成 `-`。
fn route_id(provider: &Provider) -> String {
    let mapped: String = provider
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = mapped.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "ccpanes-provider".to_string()
    } else {
        trimmed
    }
}

/// 该路由的凭据引用名。必须是 POSIX shell 标识符（dsh 的 `credentialRef` 要求）。
fn api_key_env_name(route: &str) -> String {
    let upper: String = route
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("CCPANES_{upper}_API_KEY")
}

/// Provider 类型 → dsh 的 wire protocol。
///
/// 只有明确知道协议的才映射。返回 None 表示这个类型不该走
/// 「手工声明路由」这条路（原生鉴权类：Bedrock 要 AWS 凭据、Vertex 要 ADC、
/// ConfigProfile 根本没有端点），硬塞一个 apiKey 路由只会做出一个必然失败的配置。
fn wire_protocol(provider_type: ProviderType) -> Option<&'static str> {
    match provider_type {
        // Anthropic 系（含反代）走 anthropic-messages
        ProviderType::Anthropic | ProviderType::Proxy => Some("anthropic-messages"),
        // OpenAI 兼容系
        ProviderType::OpenAI
        | ProviderType::OpenCode
        | ProviderType::Kimi
        | ProviderType::Glm
        | ProviderType::Grok => Some("openai-completions"),
        // 原生鉴权 / 无端点 / 非 LLM：不生成路由
        ProviderType::Bedrock
        | ProviderType::Vertex
        | ProviderType::ConfigProfile
        | ProviderType::Cursor
        | ProviderType::Gemini
        | ProviderType::Media => None,
    }
}

/// 把一个 Provider 映射成 dsh 的路由（JSON 对象）。不适用时返回 None。
pub(super) fn map_provider(provider: &Provider) -> Option<MappedProvider> {
    // 合成的「系统环境变量」条目不落盘也不注入，语义就是「什么都别做」。
    if provider.id == SYSTEM_PROVIDER_ID {
        return None;
    }
    let api = wire_protocol(provider.provider_type)?;
    let base_url = provider.base_url.as_ref()?;
    // 手工声明的路由必须列全模型；一个都没有就不是个能用的路由。
    if provider.models.is_empty() {
        return None;
    }

    let route = route_id(provider);
    let env_name = api_key_env_name(&route);

    let models: Vec<serde_json::Value> = provider
        .models
        .iter()
        .map(|model| {
            let mut entry = serde_json::Map::new();
            entry.insert("id".into(), model.id.as_str().into());
            if let Some(label) = &model.label {
                entry.insert("name".into(), label.as_str().into());
            }
            if let Some(window) = model.context_window_tokens {
                entry.insert("contextWindow".into(), window.into());
            }
            serde_json::Value::Object(entry)
        })
        .collect();

    let mut config = serde_json::Map::new();
    config.insert("displayName".into(), provider.name.as_str().into());
    config.insert("api".into(), api.into());
    config.insert("baseURL".into(), base_url.as_str().into());
    if provider.api_key.is_some() {
        config.insert("apiKeyEnv".into(), env_name.as_str().into());
    }
    config.insert("models".into(), models.into());

    Some(MappedProvider {
        route,
        config: serde_json::Value::Object(config),
        env: provider.api_key.as_ref().map(|key| (env_name, key.clone())),
    })
}

/// 把一组 Provider 映射成 `llm-pi-ai` 的 `providers` 配置 + 要注入的 env。
///
/// 没有任何可映射的 Provider 时返回 None——空 `providers` 会让适配器 dormant
/// 挂载，与不写等价，那就别产生一个空 patch 行。
pub(super) fn build_providers(
    providers: &[Provider],
) -> Option<(serde_json::Value, Vec<(String, String)>)> {
    let mapped: Vec<MappedProvider> = providers.iter().filter_map(map_provider).collect();
    if mapped.is_empty() {
        return None;
    }

    let mut routes = serde_json::Map::new();
    let mut env = Vec::new();
    for item in mapped {
        routes.insert(item.route, item.config);
        if let Some(pair) = item.env {
            env.push(pair);
        }
    }
    Some((serde_json::Value::Object(routes), env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::provider::ProviderModel;

    fn provider(id: &str, provider_type: ProviderType) -> Provider {
        Provider {
            id: id.to_string(),
            name: "Test Provider".to_string(),
            provider_type,
            api_key: Some("sk-secret".to_string()),
            base_url: Some("https://gw.example/v1".to_string()),
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: vec![ProviderModel {
                id: "model-a".to_string(),
                ..Default::default()
            }],
            default_model_id: None,
            is_default: false,
        }
    }

    #[test]
    fn secret_never_enters_the_config() {
        // dsh 的 doctrine：配置只带引用，不带密钥。一旦有人图省事把 key 直接
        // 写进配置，那份配置就不再能安全同步/展示。
        let (routes, env) = build_providers(&[provider("acme", ProviderType::OpenAI)]).unwrap();
        let text = serde_json::to_string(&routes).unwrap();
        assert!(!text.contains("sk-secret"), "{text}");
        assert_eq!(routes["acme"]["apiKeyEnv"], "CCPANES_ACME_API_KEY");
        assert_eq!(
            env,
            vec![("CCPANES_ACME_API_KEY".to_string(), "sk-secret".to_string())]
        );
    }

    #[test]
    fn native_auth_providers_produce_no_route() {
        // Bedrock/Vertex 要的是 AWS 凭据 / ADC，不是 apiKey；给它们生成
        // apiKey 路由等于造一个必然失败的配置。
        for kind in [
            ProviderType::Bedrock,
            ProviderType::Vertex,
            ProviderType::ConfigProfile,
        ] {
            assert!(
                map_provider(&provider("x", kind)).is_none(),
                "{kind:?} should not map to a hand-declared route"
            );
        }
    }

    #[test]
    fn system_provider_entry_is_skipped() {
        let p = provider(SYSTEM_PROVIDER_ID, ProviderType::OpenAI);
        assert!(map_provider(&p).is_none());
    }

    #[test]
    fn provider_without_models_is_skipped() {
        // 手工声明的路由必须列全模型，空列表会让每次请求 UNKNOWN_MODEL。
        let mut p = provider("acme", ProviderType::OpenAI);
        p.models.clear();
        assert!(map_provider(&p).is_none());
    }

    #[test]
    fn provider_without_base_url_is_skipped() {
        let mut p = provider("acme", ProviderType::OpenAI);
        p.base_url = None;
        assert!(map_provider(&p).is_none());
    }

    #[test]
    fn anthropic_and_openai_get_different_protocols() {
        let anthropic = map_provider(&provider("a", ProviderType::Anthropic)).unwrap();
        assert_eq!(anthropic.config["api"], "anthropic-messages");
        let openai = map_provider(&provider("o", ProviderType::OpenAI)).unwrap();
        assert_eq!(openai.config["api"], "openai-completions");
    }

    #[test]
    fn route_id_is_lowercased_and_sanitized() {
        let mapped = map_provider(&provider("My Provider!", ProviderType::OpenAI)).unwrap();
        assert_eq!(mapped.route, "my-provider");
        assert_eq!(mapped.config["apiKeyEnv"], "CCPANES_MY_PROVIDER_API_KEY");
    }

    #[test]
    fn special_characters_survive_as_json_values() {
        // 改走 JSON 后不再手写 YAML 转义——serde 负责。这条守住「别退回
        // 手拼字符串」：引号、冒号、中文都必须原样往返。
        let mut p = provider("acme", ProviderType::OpenAI);
        p.name = "Bob's \"Gateway\": 中文".to_string();
        let mapped = map_provider(&p).unwrap();
        assert_eq!(mapped.config["displayName"], "Bob's \"Gateway\": 中文");
    }

    #[test]
    fn no_mappable_provider_yields_nothing() {
        assert!(build_providers(&[]).is_none());
        assert!(build_providers(&[provider("b", ProviderType::Bedrock)]).is_none());
    }

    #[test]
    fn routes_are_keyed_by_route_name() {
        let (routes, _) = build_providers(&[
            provider("alpha", ProviderType::OpenAI),
            provider("beta", ProviderType::Anthropic),
        ])
        .unwrap();
        let obj = routes.as_object().unwrap();
        assert_eq!(obj.len(), 2);
        assert!(obj.contains_key("alpha"));
        assert!(obj.contains_key("beta"));
        assert_eq!(routes["alpha"]["models"][0]["id"], "model-a");
    }
}
