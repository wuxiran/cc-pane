use anyhow::{Context, Result};
use security_framework::{
    item::{ItemClass, ItemSearchOptions},
    os::macos::keychain::{SecKeychain, SecPreferencesDomain},
};

/// Inspect only metadata in the same user keychain used by keyring's default
/// macOS backend. keyring 3's get_attributes falls back to get_secret on macOS,
/// which can request secret-access authorization merely to render a machine list.
pub(super) fn has_password(service: &str, account: &str) -> Result<bool> {
    anyhow::ensure!(
        !service.is_empty() && !account.is_empty(),
        "Empty credential identifier"
    );
    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .context("Failed to open the user credential store")?;
    let result = ItemSearchOptions::new()
        .keychains(&[keychain])
        .class(ItemClass::generic_password())
        .service(service)
        .account(account)
        .load_attributes(true)
        .load_data(false)
        .load_refs(false)
        .search();
    match result {
        Ok(items) => Ok(!items.is_empty()),
        Err(error) if error.code() == -25300 => Ok(false), // errSecItemNotFound
        Err(error) => Err(error).context("Failed to check stored credential metadata"),
    }
}
