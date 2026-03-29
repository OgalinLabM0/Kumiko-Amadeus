import imageCompression from 'browser-image-compression';
import { db } from './db';

export const compressAndSaveImage = async (file: File): Promise<string> => {
  const options = {
    maxSizeMB: 0.2, // 200KB
    maxWidthOrHeight: 1024,
    useWebWorker: true,
  };
  
  try {
    const compressedFile = await imageCompression(file, options);
    
    // Convert to base64
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(compressedFile);
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        
        // Save to IndexedDB
        const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substring(7);
        await db.images.add({
          id: imageId,
          base64Data: base64data,
          mimeType: compressedFile.type,
          timestamp: Date.now()
        });
        
        resolve(imageId);
      };
      reader.onerror = reject;
    });
  } catch (error) {
    console.error("Error compressing image:", error);
    throw error;
  }
};

export const getImageBase64 = async (imageId: string): Promise<string | undefined> => {
  const img = await db.images.get(imageId);
  return img?.base64Data;
};

export const getImage = getImageBase64;

export const getAllImages = async () => {
  const images = await db.images.toArray();
  return images.map(img => ({
    id: img.id,
    data: img.base64Data
  }));
};

export const saveImageWithId = async (id: string, base64Data: string) => {
  const match = base64Data.match(/^data:(.*);base64,(.*)$/);
  const mimeType = match ? match[1] : 'image/jpeg';
  
  await db.images.put({
    id,
    base64Data,
    mimeType,
    timestamp: Date.now()
  });
};

export const imageService = {
  compressAndSaveImage,
  getImageBase64,
  getImage,
  getAllImages,
  saveImageWithId
};
