import { describe, expect, it, vi } from 'vitest';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils.js';
import type { PickedFile } from '../src/services/ingestion/types';

const CANONICAL_EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('M2 Challenger 1: Expo FileSystem Pathway Simulation', () => {
  it('routes zero-byte files directly to canonical hash without reading bytes', async () => {
    vi.resetModules();

    const mockReadBytes = vi.fn();
    const mockSha256File = vi.fn();
    const mockFileSize = vi.fn().mockResolvedValue(0);

    vi.doMock('../src/services/ingestion/read-file', () => ({
      readBytes: mockReadBytes,
      sha256File: mockSha256File,
      fileSize: mockFileSize,
      sha256Hex: (bytes: Uint8Array) => nobleBytesToHex(nobleSha256(bytes)),
    }));

    const { computeFileSha256 } = await import('../src/services/ingestion/dedup');

    // Case 1: size specified as 0
    const fileWithZeroSize: PickedFile = {
      uri: 'file:///data/user/0/app/cache/zero.bin',
      name: 'zero.bin',
      mimeType: 'application/octet-stream',
      size: 0,
    };
    const hash1 = await computeFileSha256(fileWithZeroSize);
    expect(hash1).toBe(CANONICAL_EMPTY_SHA256);
    expect(mockReadBytes).not.toHaveBeenCalled();
    expect(mockSha256File).not.toHaveBeenCalled();

    // Case 2: size is null, but fileSize returns 0
    const fileWithNullSize: PickedFile = {
      uri: 'file:///data/user/0/app/cache/discovered_zero.bin',
      name: 'discovered_zero.bin',
      mimeType: 'application/octet-stream',
      size: null,
    };
    const hash2 = await computeFileSha256(fileWithNullSize);
    expect(hash2).toBe(CANONICAL_EMPTY_SHA256);
    expect(mockFileSize).toHaveBeenCalledWith('file:///data/user/0/app/cache/discovered_zero.bin');
    expect(mockReadBytes).not.toHaveBeenCalled();
    expect(mockSha256File).not.toHaveBeenCalled();
  });

  it('routes large files (> 2MB) through sha256File streaming rather than readBytes', async () => {
    vi.resetModules();

    const largeSize = 5 * 1024 * 1024; // 5 MB
    const expectedStreamHash = 'deadbeef'.repeat(8);

    const mockReadBytes = vi.fn();
    const mockSha256File = vi.fn().mockResolvedValue(expectedStreamHash);
    const mockFileSize = vi.fn().mockResolvedValue(largeSize);

    vi.doMock('../src/services/ingestion/read-file', () => ({
      readBytes: mockReadBytes,
      sha256File: mockSha256File,
      fileSize: mockFileSize,
      sha256Hex: (bytes: Uint8Array) => nobleBytesToHex(nobleSha256(bytes)),
    }));

    const { computeFileSha256 } = await import('../src/services/ingestion/dedup');

    const largeFile: PickedFile = {
      uri: 'file:///data/user/0/app/cache/large_video.mp4',
      name: 'large_video.mp4',
      mimeType: 'video/mp4',
      size: largeSize,
    };

    const hash = await computeFileSha256(largeFile);
    expect(hash).toBe(expectedStreamHash);
    expect(mockSha256File).toHaveBeenCalledWith('file:///data/user/0/app/cache/large_video.mp4', largeSize);
    expect(mockReadBytes).not.toHaveBeenCalled(); // Crucial: avoid heap OOM
  });

  it('routes small files (<= 2MB) through readBytes and sha256Hex', async () => {
    vi.resetModules();

    const smallContent = new TextEncoder().encode('Mobile report body content');
    const smallExpectedHash = nobleBytesToHex(nobleSha256(smallContent));

    const mockReadBytes = vi.fn().mockResolvedValue(smallContent);
    const mockSha256File = vi.fn();
    const mockFileSize = vi.fn().mockResolvedValue(smallContent.length);

    vi.doMock('../src/services/ingestion/read-file', () => ({
      readBytes: mockReadBytes,
      sha256File: mockSha256File,
      fileSize: mockFileSize,
      sha256Hex: (bytes: Uint8Array) => nobleBytesToHex(nobleSha256(bytes)),
    }));

    const { computeFileSha256 } = await import('../src/services/ingestion/dedup');

    const smallFile: PickedFile = {
      uri: 'file:///data/user/0/app/cache/small_report.txt',
      name: 'small_report.txt',
      mimeType: 'text/plain',
      size: smallContent.length,
    };

    const hash = await computeFileSha256(smallFile);
    expect(hash).toBe(smallExpectedHash);
    expect(mockReadBytes).toHaveBeenCalledWith('file:///data/user/0/app/cache/small_report.txt');
    expect(mockSha256File).not.toHaveBeenCalled();
  });
});
