use crate::utils::AppResult;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{ImageReader, RgbaImage};
use std::io::Cursor;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;

/// Decode the actual pasted/dropped file, never whatever is on the clipboard now.
pub(super) fn decode_attachment(encoded: &str) -> AppResult<RgbaImage> {
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("Image exceeds the 10 MiB attachment limit".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid image attachment encoding")?;
    if bytes.len() > MAX_BYTES {
        return Err("Image exceeds the 10 MiB attachment limit".into());
    }
    let (width, height) = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("Unable to identify image attachment: {e}"))?
        .into_dimensions()
        .map_err(|e| format!("Invalid image attachment: {e}"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("Image dimensions exceed the 16 megapixel attachment limit".into());
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("Unable to identify image attachment: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map(|image| image.into_rgba8())
        .map_err(|e| format!("Unable to decode image attachment: {e}").into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_supplied_png_pixels() {
        let image = RgbaImage::from_pixel(4, 3, image::Rgba([30, 80, 120, 255]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let decoded = decode_attachment(&STANDARD.encode(bytes.into_inner())).unwrap();
        assert_eq!(decoded, image);
    }

    #[test]
    fn rejects_invalid_payload_without_publishing_a_file() {
        for value in ["not base64!".to_string(), STANDARD.encode(b"not an image")] {
            assert!(decode_attachment(&value).is_err());
        }
    }

    #[test]
    fn rejects_oversized_payload_before_base64_decoding() {
        let encoded = "A".repeat(MAX_BYTES.div_ceil(3) * 4 + 1);
        let error = decode_attachment(&encoded).unwrap_err();
        assert!(error.to_string().contains("10 MiB"));
    }

    #[test]
    fn rejects_large_dimensions_before_decoding_pixels() {
        let mut bytes = vec![0u8; 54];
        bytes[0..2].copy_from_slice(b"BM");
        bytes[10..14].copy_from_slice(&54u32.to_le_bytes());
        bytes[14..18].copy_from_slice(&40u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&5000i32.to_le_bytes());
        bytes[22..26].copy_from_slice(&5000i32.to_le_bytes());
        bytes[26..28].copy_from_slice(&1u16.to_le_bytes());
        bytes[28..30].copy_from_slice(&24u16.to_le_bytes());
        let error = decode_attachment(&STANDARD.encode(bytes)).unwrap_err();
        assert!(error.to_string().contains("16 megapixel"));
    }
}
