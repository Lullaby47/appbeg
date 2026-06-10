export type PaymentReferencePhotoAuditInput = {
  routeOrPage: string;
  role: string;
  coadminUid: string;
  source: string;
  cloudinaryUsed: boolean;
  tableOrCollection: string;
  photoCount: number;
  samplePhotoIds: string[];
  sampleUrlsPresent: boolean;
  reason: string;
};

export function logPaymentReferencePhotoAudit(input: PaymentReferencePhotoAuditInput) {
  console.info('[PAYMENT_REFERENCE_PHOTO_AUDIT]', input);
}

export function logPaymentReferencePhotoSqlWrite(input: {
  action: 'create' | 'delete';
  coadminUid: string;
  photoId: string;
  hasImageUrl: boolean;
  hasCloudinaryPublicId: boolean;
  ok: boolean;
  reason: string;
}) {
  console.info('[PAYMENT_REFERENCE_PHOTO_SQL_WRITE]', input);
}

export function logPaymentReferencePhotoRandomPick(input: {
  coadminUid: string;
  source: string;
  photoCount: number;
  selectedPhotoId: string | null;
  selectedUrlPresent: boolean;
}) {
  console.info('[PAYMENT_REFERENCE_PHOTO_RANDOM_PICK]', input);
}
