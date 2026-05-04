import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { nanoid } from 'nanoid';
import type { Env } from '../env';

/**
 * S3-compatible storage layer. The S3 protocol is implemented by R2,
 * MinIO, AWS S3, Backblaze B2, Wasabi, and others — pointing at any of
 * them is purely an env-var change. Clients in this module never depend
 * on the underlying provider.
 *
 * Replaces the Workers-era `r2.ts` 1:1 in semantics. Same key-generation
 * helpers; same put/get/delete shape, but driven by `@aws-sdk/client-s3`
 * instead of the R2 binding.
 */

let _client: S3Client | null = null;

function getClient(env: Env): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

export interface PhotoKeyParts {
  householdId: string;
  // 'seeds' for photos tied to a seed row, 'extractions' for catalog
  // extraction inputs that may not yet be associated with a seed.
  scope: 'seeds' | 'extractions';
  ownerId: string; // seed id or extraction id
  role: 'front' | 'back' | 'extra';
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/heic']);

export function newPhotoKey(parts: PhotoKeyParts): string {
  const photoId = nanoid();
  // households/<household>/seeds/<seedId>/front-<photo>.jpg
  return `households/${parts.householdId}/${parts.scope}/${parts.ownerId}/${parts.role}-${photoId}.jpg`;
}

export function isAllowedMime(mime: string | null | undefined): boolean {
  return !!mime && ALLOWED_MIME.has(mime);
}

export async function putPhoto(
  env: Env,
  key: string,
  body: Uint8Array | ArrayBuffer | Buffer,
  mime: string,
): Promise<void> {
  const buf =
    body instanceof ArrayBuffer ? new Uint8Array(body) :
    body instanceof Uint8Array ? body :
    new Uint8Array(body);
  await getClient(env).send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: buf,
    ContentType: mime,
    CacheControl: 'private, max-age=3600',
  }));
}

export async function deletePhoto(env: Env, key: string): Promise<void> {
  await getClient(env).send(new DeleteObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
  }));
}

export interface PhotoBody {
  bytes: Uint8Array;
  contentType: string;
}

export async function getPhoto(env: Env, key: string): Promise<PhotoBody | null> {
  try {
    const result = await getClient(env).send(new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
    }));
    if (!result.Body) return null;
    const bytes = await result.Body.transformToByteArray();
    return {
      bytes,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  } catch (err) {
    // S3 returns NoSuchKey when the object is missing.
    const e = err as { name?: string; Code?: string };
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return null;
    throw err;
  }
}
