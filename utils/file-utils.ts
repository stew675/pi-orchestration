import * as fs from "node:fs";
import { notifyTui as coreNotifyTui } from "../core";

const MAX_FILE_SIZE = 50_000; // 50KB cap on injected file contents

/**
 * Well-known binary magic byte signatures (RFC 2045, IANA media types).
 * Checked against the first N bytes of a file to reject obvious binaries.
 */
const BINARY_MAGIC_BYTES: Array<{ offset: number; bytes: number[] }> = [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }, // PNG
    { offset: 0, bytes: [0xff, 0xd8, 0xff] }, // JPEG
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF
    { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // PDF
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP / JAR / DOCX / XLSX
    { offset: 0, bytes: [0x1f, 0x8b] }, // GZIP
    { offset: 0, bytes: [0x42, 0x4d] }, // BMP
    { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF (executables)
    { offset: 0, bytes: [0x4d, 0x5a] }, // PE / EXE / DLL
    { offset: 0, bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70] }, // MP4 / MOV (offset 4)
    { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // MP4 variant
    { offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }, // XZ
    { offset: 0, bytes: [0x1f, 0x9d] }, // LZW
    { offset: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd] }, // Zstd
    { offset: 0, bytes: [0x75, 0x53, 0x54, 0x52] } // RAR
];

/** Check if a buffer starts with any known binary magic signature. */
function hasBinaryMagic(buffer: Buffer): boolean {
    if (buffer.length < 2) return false;
    for (const sig of BINARY_MAGIC_BYTES) {
        if (buffer.length < sig.offset + sig.bytes.length) continue;
        let match = true;
        for (let i = 0; i < sig.bytes.length; i++) {
            if (buffer[sig.offset + i] !== sig.bytes[i]) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

/**
 * Read a file as text only if it appears to be a valid text file.
 * Rejects binary files (magic bytes, null bytes, high replacement-char ratio).
 * Returns null if the file is too large, binary, or unreadable.
 */
export function readTextFile(filePath: string): string | null {
    try {
        const buffer = fs.readFileSync(filePath);
        if (buffer.length > MAX_FILE_SIZE) {
            coreNotifyTui(`Skipping ${filePath}: exceeds ${MAX_FILE_SIZE} byte limit`);
            return null;
        }
        // Reject well-known binary formats by magic bytes
        if (hasBinaryMagic(buffer)) {
            return null;
        }
        const content = buffer.toString("utf-8");
        // Reject files containing null bytes (strong indicator of binary data)
        if (content.includes("\0")) {
            return null;
        }
        // Heuristic: if >5% of characters are the Unicode replacement char,
        // the file is likely not valid UTF-8 text.
        const replacementCount = (content.match(/\uFFFD/g) || []).length;
        if (replacementCount > 0 && replacementCount / content.length > 0.05) {
            return null;
        }
        return content;
    } catch {
        return null;
    }
}
