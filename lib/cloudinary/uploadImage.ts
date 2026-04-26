export type CloudinaryUploadResult = {
  url: string;
  publicId: string;
};

export async function uploadImageToCloudinary(
  file: File
): Promise<CloudinaryUploadResult> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are allowed.');
  }

  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName) {
    throw new Error(
      'Cloudinary is not configured: NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME is missing.'
    );
  }
  if (!uploadPreset) {
    throw new Error(
      'Cloudinary is not configured: NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET is missing.'
    );
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', uploadPreset);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: 'POST',
      body: formData,
    }
  );

  const data = (await response.json().catch(() => null)) as
    | {
        secure_url?: string;
        public_id?: string;
        error?: { message?: string };
      }
    | null;

  if (!response.ok || !data?.secure_url || !data?.public_id) {
    const reason =
      data?.error?.message || 'Cloudinary upload failed with unknown error.';
    throw new Error(`Image upload failed: ${reason}`);
  }

  return {
    url: data.secure_url,
    publicId: data.public_id,
  };
}
