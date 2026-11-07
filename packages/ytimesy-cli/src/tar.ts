import { gzipSync } from "node:zlib";

/** A minimal ustar writer: regular files and directories, gzip-compressed. */

export type TarEntry =
	| { readonly name: string; readonly type: "directory" }
	| { readonly name: string; readonly type: "file"; readonly data: Uint8Array };

const BLOCK = 512;

function writeString(
	header: Buffer,
	offset: number,
	size: number,
	text: string,
) {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength > size) throw new Error(`Tar field too long: ${text}`);
	bytes.copy(header, offset);
}

function writeOctal(
	header: Buffer,
	offset: number,
	size: number,
	value: number,
) {
	const text = value.toString(8).padStart(size - 1, "0");
	if (text.length > size - 1) throw new Error("Tar entry too large.");
	writeString(header, offset, size, `${text}\0`);
}

/** name (≤100 bytes) or prefix/name split at a slash (≤155 + 100). */
function splitName(name: string): [string, string] {
	if (Buffer.byteLength(name) <= 100) return ["", name];
	for (
		let at = name.lastIndexOf("/");
		at > 0;
		at = name.lastIndexOf("/", at - 1)
	) {
		const prefix = name.slice(0, at);
		const rest = name.slice(at + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100)
			return [prefix, rest];
	}
	throw new Error(`Tar path too long: ${name}`);
}

function header(entry: TarEntry, mtime: number) {
	const block = Buffer.alloc(BLOCK);
	const name =
		entry.type === "directory" && !entry.name.endsWith("/")
			? `${entry.name}/`
			: entry.name;
	const [prefix, rest] = splitName(name);
	writeString(block, 0, 100, rest);
	writeOctal(block, 100, 8, entry.type === "directory" ? 0o755 : 0o644);
	writeOctal(block, 108, 8, 0);
	writeOctal(block, 116, 8, 0);
	writeOctal(block, 124, 12, entry.type === "file" ? entry.data.byteLength : 0);
	writeOctal(block, 136, 12, Math.floor(mtime / 1000));
	block.fill(0x20, 148, 156);
	writeString(block, 156, 1, entry.type === "directory" ? "5" : "0");
	writeString(block, 257, 6, "ustar\0");
	writeString(block, 263, 2, "00");
	writeString(block, 345, 155, prefix);
	let sum = 0;
	for (const byte of block) sum += byte;
	writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return block;
}

export function tarBytes(entries: readonly TarEntry[], mtime = Date.now()) {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		parts.push(header(entry, mtime));
		if (entry.type === "file") {
			parts.push(Buffer.from(entry.data));
			const padding = (BLOCK - (entry.data.byteLength % BLOCK)) % BLOCK;
			if (padding) parts.push(Buffer.alloc(padding));
		}
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return Buffer.concat(parts);
}

export function tarGz(entries: readonly TarEntry[], mtime = Date.now()) {
	return gzipSync(tarBytes(entries, mtime));
}
