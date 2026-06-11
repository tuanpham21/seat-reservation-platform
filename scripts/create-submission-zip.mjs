#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const outputDir = path.join(rootDir, "dist");
const outputFile = path.join(outputDir, "seat-reservation-platform-submission.zip");

const excludedDirectories = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vercel",
  ".vscode",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "tmp"
]);

const excludedFiles = new Set([".DS_Store", "Thumbs.db", "CONTEXT.md"]);

function toZipPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function shouldExclude(relativePath) {
  const normalized = toZipPath(relativePath);
  const segments = normalized.split("/");
  const baseName = segments[segments.length - 1];

  if (segments.some((segment) => excludedDirectories.has(segment))) {
    return true;
  }

  if (excludedFiles.has(baseName)) {
    return true;
  }

  if (baseName === ".env") {
    return true;
  }

  if (baseName.startsWith(".env.") && baseName !== ".env.example") {
    return true;
  }

  if (baseName.endsWith(".log") || /^(npm|yarn|pnpm)-debug\.log/.test(baseName)) {
    return true;
  }

  if (baseName.endsWith(".zip") || baseName.endsWith(".tsbuildinfo")) {
    return true;
  }

  if (/\.(sqlite|sqlite3|db)$/i.test(baseName)) {
    return true;
  }

  if (/\.(sqlite|sqlite3|db)-(journal|wal|shm)$/i.test(baseName)) {
    return true;
  }

  return false;
}

function collectFiles(directory) {
  const files = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(rootDir, absolutePath);

    if (shouldExclude(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...collectFiles(absolutePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      absolutePath,
      relativePath: toZipPath(relativePath),
      stat: fs.statSync(absolutePath)
    });
  }

  return files;
}

const crcTable = new Uint32Array(256);

for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);

  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.relativePath);
    const content = fs.readFileSync(file.absolutePath);
    const compressed = zlib.deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);
    const dos = toDosDateTime(file.stat.mtime);
    const externalAttributes = ((file.stat.mode & 0xffff) << 16) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dos.time, 10);
    localHeader.writeUInt16LE(dos.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dos.time, 12);
    centralHeader.writeUInt16LE(dos.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttributes, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const files = collectFiles(rootDir);

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(outputFile, { force: true });
fs.writeFileSync(outputFile, createZip(files));

const sizeInBytes = fs.statSync(outputFile).size;
const relativeOutput = path.relative(rootDir, outputFile);

console.log(`Created ${relativeOutput}`);
console.log(`Included ${files.length} files, ${Math.round(sizeInBytes / 1024)} KB`);
