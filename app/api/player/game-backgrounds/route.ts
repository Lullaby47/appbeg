import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeBackgroundKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function GET() {
  try {
    const backgroundDir = path.join(process.cwd(), 'public', 'gamebackgroundimage');
    const entries = await readdir(backgroundDir, { withFileTypes: true });
    const backgrounds = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const ext = path.extname(entry.name).toLowerCase();
        const baseName = path.basename(entry.name, ext);
        return { ext, baseName, name: entry.name };
      })
      .filter((entry) => IMAGE_EXTENSIONS.has(entry.ext))
      .map((entry) => ({
        key: normalizeBackgroundKey(entry.baseName),
        imageUrl: `/gamebackgroundimage/${encodeURIComponent(entry.name)}`,
      }))
      .filter((entry) => Boolean(entry.key));

    return NextResponse.json(
      { backgrounds },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  } catch {
    return NextResponse.json(
      { backgrounds: [] },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  }
}
