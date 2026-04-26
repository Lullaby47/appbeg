'use client';

import { useMemo, useState } from 'react';

import {
  uploadImageToCloudinary,
  type CloudinaryUploadResult,
} from '@/lib/cloudinary/uploadImage';

type Props = {
  label?: string;
  valueUrl?: string;
  onUploaded: (uploaded: CloudinaryUploadResult) => void;
  onError?: (message: string) => void;
  className?: string;
  autoUpload?: boolean;
};

export default function ImageUploadField({
  label = 'Upload image',
  valueUrl,
  onUploaded,
  onError,
  className,
  autoUpload = true,
}: Props) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const displayedPreview = useMemo(() => {
    return previewUrl || valueUrl || '';
  }, [previewUrl, valueUrl]);

  async function startUpload(file: File) {
    if (!file.type.startsWith('image/')) {
      const msg = 'Image upload failed. Please try again.';
      setError(msg);
      onError?.(msg);
      return;
    }
    setUploading(true);
    setError('');
    setSuccess('');
    try {
      const uploaded = await uploadImageToCloudinary(file);
      onUploaded(uploaded);
      setSuccess('Image uploaded successfully.');
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : 'Image upload failed. Please try again.';
      setError(msg);
      onError?.(msg);
    } finally {
      setUploading(false);
    }
  }

  function handleFileChange(file: File | null) {
    setSuccess('');
    setError('');
    if (!file) {
      setSelectedFile(null);
      setPreviewUrl('');
      return;
    }
    if (!file.type.startsWith('image/')) {
      const msg = 'Image upload failed. Please try again.';
      setError(msg);
      onError?.(msg);
      setSelectedFile(null);
      setPreviewUrl('');
      return;
    }
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    if (autoUpload) {
      void startUpload(file);
    }
  }

  return (
    <div className={className || 'space-y-3'}>
      <label className="block text-sm font-semibold text-neutral-200">{label}</label>
      {displayedPreview ? (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
          <img
            src={displayedPreview}
            alt="Selected"
            className="max-h-56 w-full object-contain"
          />
        </div>
      ) : null}
      <input
        type="file"
        accept="image/*"
        onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
        className="block min-h-[44px] w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white file:mr-3 file:rounded-lg file:border-0 file:bg-white/15 file:px-3 file:py-2 file:font-semibold"
      />
      {!autoUpload ? (
        <button
          type="button"
          disabled={!selectedFile || uploading}
          onClick={() => {
            if (selectedFile) {
              void startUpload(selectedFile);
            }
          }}
          className="min-h-[44px] rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-neutral-200 disabled:opacity-50"
        >
          {uploading ? 'Uploading...' : 'Upload image'}
        </button>
      ) : uploading ? (
        <p className="text-sm text-amber-200">Uploading...</p>
      ) : null}
      {success ? <p className="text-sm text-emerald-300">{success}</p> : null}
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}
