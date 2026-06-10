const { Pool } = require('pg');
const { randomUUID } = require('crypto');

function argValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  const hit = index >= 0 ? process.argv[index] : null;
  if (!hit) return null;
  if (hit === name) {
    const next = process.argv[index + 1];
    return next && !next.startsWith('--') ? next : 'true';
  }
  return hit.slice(prefix.length);
}

const DRY_RUN = argValue('--dry-run') !== null;
const ONLY_MISSING = argValue('--only-missing') !== null;
const LIMIT = Number(argValue('--limit') || '0') || 0;

function clean(value) {
  return String(value || '').trim();
}

function createPgPool() {
  const connectionString = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (connectionString) {
    return new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  }
  const password = clean(process.env.APPBEG_PG_PASSWORD);
  if (!password) {
    throw new Error('DATABASE_URL or APPBEG_PG_PASSWORD is required');
  }
  return new Pool({
    host: clean(process.env.APPBEG_PG_HOST || '127.0.0.1'),
    port: Number(process.env.APPBEG_PG_PORT || '5433'),
    database: clean(process.env.APPBEG_PG_DATABASE || 'appbeg'),
    user: clean(process.env.APPBEG_PG_USER || 'appbeg_user'),
    password,
    connectionTimeoutMillis: 10_000,
  });
}

function parseRaw(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
}

function extractPhotos(coadminUid, raw) {
  const rows = [];
  const seen = new Set();

  const push = (imageUrl, cloudinaryPublicId, sortOrder, rawEntry) => {
    const url = clean(imageUrl);
    if (!url) return;
    const dedupeKey = `${coadminUid}::${url}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    rows.push({
      photoId: randomUUID(),
      coadminUid,
      imageUrl: url,
      cloudinaryPublicId: clean(cloudinaryPublicId) || null,
      sortOrder,
      rawData: rawEntry || {},
    });
  };

  const structured = Array.isArray(raw.paymentDetailPhotos) ? raw.paymentDetailPhotos : [];
  structured.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    push(entry.imageUrl, entry.imagePublicId, index, entry);
  });

  const legacyUrls = Array.isArray(raw.paymentDetailPhotoUrls) ? raw.paymentDetailPhotoUrls : [];
  legacyUrls.forEach((entry, index) => {
    push(entry, '', structured.length + index, { imageUrl: entry, legacy: true });
  });

  return rows;
}

async function main() {
  const pool = createPgPool();
  const client = await pool.connect();
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;

  try {
    const { rows } = await client.query(
      `
        SELECT uid, role, raw_firestore_data
        FROM public.players_cache
        WHERE deleted_at IS NULL
          AND role = 'coadmin'
        ORDER BY uid ASC
      `
    );

    for (const row of rows) {
      if (LIMIT > 0 && scanned >= LIMIT) break;
      scanned += 1;
      const coadminUid = clean(row.uid);
      const raw = parseRaw(row.raw_firestore_data);
      const photos = extractPhotos(coadminUid, raw);
      if (!photos.length) {
        skipped += 1;
        continue;
      }

      for (const photo of photos) {
        if (ONLY_MISSING) {
          const existing = await client.query(
            `
              SELECT photo_id
              FROM public.payment_reference_photos_cache
              WHERE coadmin_uid = $1
                AND image_url = $2
                AND deleted_at IS NULL
              LIMIT 1
            `,
            [photo.coadminUid, photo.imageUrl]
          );
          if (existing.rows.length > 0) {
            skipped += 1;
            continue;
          }
        }

        if (DRY_RUN) {
          console.info('[DRY_RUN] would insert', {
            coadminUid: photo.coadminUid,
            imageUrl: photo.imageUrl,
            cloudinaryPublicId: photo.cloudinaryPublicId,
          });
          inserted += 1;
          continue;
        }

        await client.query(
          `
            INSERT INTO public.payment_reference_photos_cache (
              photo_id, coadmin_uid, image_url, cloudinary_public_id, label,
              sort_order, is_active, created_at, updated_at, deleted_at, raw_data
            )
            SELECT $1, $2, $3, NULLIF($4, ''), NULL, $5, TRUE, now(), now(), NULL, $6::jsonb
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.payment_reference_photos_cache
              WHERE coadmin_uid = $2
                AND image_url = $3
                AND deleted_at IS NULL
            )
          `,
          [
            photo.photoId,
            photo.coadminUid,
            photo.imageUrl,
            photo.cloudinaryPublicId,
            photo.sortOrder,
            JSON.stringify({
              source: 'backfill_players_cache',
              ...photo.rawData,
            }),
          ]
        );
        inserted += 1;
      }
    }

    console.info('[BACKFILL_PAYMENT_REFERENCE_PHOTOS] done', {
      dryRun: DRY_RUN,
      onlyMissing: ONLY_MISSING,
      scannedCoadmins: scanned,
      inserted,
      skipped,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[BACKFILL_PAYMENT_REFERENCE_PHOTOS] failed', error);
  process.exit(1);
});
