pub fn decode_text_lossy_gbk(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.strip_prefix('\u{feff}').unwrap_or(text).to_string();
    }

    let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
    decoded.into_owned()
}

#[cfg(test)]
mod tests {
    use super::decode_text_lossy_gbk;

    #[test]
    fn decodes_utf8_and_gbk() {
        assert_eq!(decode_text_lossy_gbk("中文".as_bytes()), "中文");
        let (gbk, _, _) = encoding_rs::GBK.encode("中文");
        assert_eq!(decode_text_lossy_gbk(&gbk), "中文");
    }
}
