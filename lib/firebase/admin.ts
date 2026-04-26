import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (!base64) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_BASE64');
}

const serviceAccount = JSON.parse(
  Buffer.from(base64, 'base64').toString('utf8')
);

const app =
  getApps().length === 0
    ? initializeApp({
        credential: cert(serviceAccount),
      })
    : getApps()[0];

export const adminAuth = getAuth(app);
export const adminDb = getFirestore(app);