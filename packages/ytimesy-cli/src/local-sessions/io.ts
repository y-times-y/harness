import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const NEWLINE = 0x0a;
const DEFAULT_CHUNK_BYTES = 256 * 1024;

export type JsonObject = Record<string, unknown>;

export function parseJsonObject(line: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isJsonObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function fileMtimeMs(file: string): number | undefined {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}

export function listDirectory(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Reads at most `maxBytes` from the start of a file; never the whole file (a `.zst` file is partly decompressed). */
export function readHeadText(file: string, maxBytes: number): string {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
		const head = buffer.subarray(0, bytesRead);
		if (!isCompressedFile(file)) return head.toString("utf8");
		return zstdPrefix(head).subarray(0, maxBytes).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * Decompressed text of the first `compressedBytes` of a `.zst` file (not cut to a
 * length), with how many compressed bytes were read.
 */
export function readCompressedHead(
	file: string,
	compressedBytes: number,
): { text: string; compressedRead: number } {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(compressedBytes);
		const bytesRead = fs.readSync(fd, buffer, 0, compressedBytes, 0);
		return {
			text: zstdPrefix(buffer.subarray(0, bytesRead)).toString("utf8"),
			compressedRead: bytesRead,
		};
	} catch {
		return { text: "", compressedRead: 0 };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Codex compresses older rollouts to `.jsonl.zst`; readers treat them like the plain file. */
export function isCompressedFile(file: string): boolean {
	return file.endsWith(".zst");
}

/** Decompresses as much of a zstd prefix as is complete; the rest is ignored. */
function zstdPrefix(compressed: Buffer): Buffer {
	const decompress = (zlib as { zstdDecompressSync?: typeof zlib.inflateSync })
		.zstdDecompressSync;
	if (!decompress) return Buffer.alloc(0);
	try {
		return decompress(compressed, {
			finishFlush: (zlib.constants as Record<string, number>).ZSTD_e_flush,
		} as zlib.ZlibOptions);
	} catch {
		return Buffer.alloc(0);
	}
}

let decompressedCache: { key: string; data: Buffer } | undefined;

/**
 * The whole decompressed content of a `.zst` file. Node has no synchronous streaming
 * zstd API, so the file is decompressed at once; the newest result is cached because
 * a reader passes over the same rollout more than once.
 */
function decompressedFile(file: string): Buffer | undefined {
	const mtime = fileMtimeMs(file);
	const key = `${file}:${mtime}`;
	if (decompressedCache?.key === key) return decompressedCache.data;
	const decompress = (zlib as { zstdDecompressSync?: typeof zlib.inflateSync })
		.zstdDecompressSync;
	if (!decompress) return undefined;
	try {
		const data = decompress(fs.readFileSync(file));
		decompressedCache = { key, data };
		return data;
	} catch {
		return undefined;
	}
}

/** Random-access bytes: a plain file, or a decompressed `.zst` file held in memory. */
interface ByteSource {
	size: number;
	read(target: Buffer, length: number, position: number): number;
	close(): void;
}

function openByteSource(file: string): ByteSource | undefined {
	if (isCompressedFile(file)) {
		const data = decompressedFile(file);
		if (!data) return undefined;
		return {
			size: data.length,
			read: (target, length, position) =>
				data.copy(
					target,
					0,
					position,
					Math.min(data.length, position + length),
				),
			close: () => {},
		};
	}
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return undefined;
	}
	return {
		size: fs.fstatSync(fd).size,
		read: (target, length, position) =>
			fs.readSync(fd, target, 0, length, position),
		close: () => fs.closeSync(fd),
	};
}

/** Complete lines from the first `maxBytes` of a file (a cut-off last line is dropped). */
export function readHeadLines(file: string, maxBytes: number): string[] {
	const text = readHeadText(file, maxBytes);
	const lines = text.split("\n");
	if (text.length >= maxBytes) lines.pop();
	return lines.filter((line) => line.trim().length > 0);
}

/** The first non-empty line of a file, reading forward in small chunks until a newline. */
export function readFirstLine(file: string): string | undefined {
	if (isCompressedFile(file)) {
		// Partial decompression of a growing prefix; never the whole rollout.
		for (const bytes of [64 * 1024, 1024 * 1024, 16 * 1024 * 1024]) {
			const text = readHeadText(file, bytes);
			const lines = text.split("\n");
			const complete = lines.length > 1 || text.length < bytes;
			const first = (complete ? lines : []).find((line) => line.trim());
			if (first) return first;
			if (text.length < bytes) return undefined;
		}
		return undefined;
	}
	for (const line of linesForward(file, 64 * 1024)) {
		return line;
	}
	return undefined;
}

/** Streams lines from the start of a file in fixed-size chunks. */
export function* linesForward(
	file: string,
	chunkBytes = DEFAULT_CHUNK_BYTES,
): Generator<string> {
	const source = openByteSource(file);
	if (!source) return;
	try {
		const buffer = Buffer.alloc(chunkBytes);
		let carry: Buffer[] = [];
		let position = 0;
		while (true) {
			const bytesRead = source.read(buffer, chunkBytes, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			let start = 0;
			const chunk = buffer.subarray(0, bytesRead);
			let newline = chunk.indexOf(NEWLINE, start);
			while (newline !== -1) {
				const piece = chunk.subarray(start, newline);
				const line =
					carry.length > 0
						? Buffer.concat([...carry, piece]).toString("utf8")
						: piece.toString("utf8");
				carry = [];
				if (line.trim().length > 0) yield line;
				start = newline + 1;
				newline = chunk.indexOf(NEWLINE, start);
			}
			if (start < bytesRead) carry.push(Buffer.from(chunk.subarray(start)));
		}
		if (carry.length > 0) {
			const line = Buffer.concat(carry).toString("utf8");
			if (line.trim().length > 0) yield line;
		}
	} finally {
		source.close();
	}
}

/**
 * Streams lines from the end of a file towards the start, reading fixed-size
 * chunks backwards. Splits on raw bytes so multi-byte characters stay intact.
 */
export function* linesBackward(
	file: string,
	chunkBytes = DEFAULT_CHUNK_BYTES,
): Generator<string> {
	const source = openByteSource(file);
	if (!source) return;
	try {
		let position = source.size;
		let carry: Buffer = Buffer.alloc(0);
		while (position > 0) {
			const readBytes = Math.min(chunkBytes, position);
			position -= readBytes;
			const chunk = Buffer.alloc(readBytes);
			source.read(chunk, readBytes, position);
			const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
			let end = combined.length;
			let newline = combined.lastIndexOf(NEWLINE, end - 1);
			while (newline !== -1) {
				const line = combined.subarray(newline + 1, end).toString("utf8");
				if (line.trim().length > 0) yield line;
				end = newline;
				newline = end > 0 ? combined.lastIndexOf(NEWLINE, end - 1) : -1;
			}
			carry = Buffer.from(combined.subarray(0, end));
		}
		if (carry.length > 0) {
			const line = carry.toString("utf8");
			if (line.trim().length > 0) yield line;
		}
	} finally {
		source.close();
	}
}

/** realpath when the path exists (so /tmp and /private/tmp compare equal), otherwise the resolved path. */
export function canonicalPath(input: string): string {
	const resolved = path.resolve(input);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export function isPathInside(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	return candidate.startsWith(prefix);
}

/** Finds the enclosing git work tree root by walking up to a `.git` entry (file or directory). */
export function findGitRoot(start: string): string | undefined {
	let current = canonicalPath(start);
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function fileUrlToPath(value: string): string {
	return value.startsWith("file://")
		? decodeURIComponent(value.slice("file://".length))
		: value;
}
