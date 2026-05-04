/**
 * Storage smoke test — round-trip a blob through MinIO via the storage
 * layer to confirm put/get/delete all work. Not part of the test suite;
 * run manually with `bun run scripts/storage-smoke.ts` after `docker
 * compose up minio minio-bootstrap`.
 */

import { loadEnv } from '../src/env';
import { putPhoto, getPhoto, deletePhoto, newPhotoKey } from '../src/lib/storage';

const env = loadEnv();
const key = newPhotoKey({ householdId: 'smoke', scope: 'seeds', ownerId: 'test', role: 'front' });
const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xde, 0xad, 0xbe, 0xef]);

await putPhoto(env, key, original, 'image/jpeg');
console.log('PUT  ok:', key);

const got = await getPhoto(env, key);
console.log('GET  ok:', got?.bytes.length, 'bytes,', got?.contentType);

const match = got && got.bytes.length === original.length &&
  Array.from(got.bytes).every((b, i) => b === original[i]);
console.log('round-trip:', match ? 'IDENTICAL' : 'MISMATCH');

await deletePhoto(env, key);
console.log('DELETE ok');

const afterDelete = await getPhoto(env, key);
console.log('after delete:', afterDelete === null ? 'gone (correct)' : 'STILL THERE (bug)');

process.exit(match && afterDelete === null ? 0 : 1);
