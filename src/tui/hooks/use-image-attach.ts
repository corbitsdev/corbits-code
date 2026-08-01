import { useState, type Dispatch, type SetStateAction } from "react";
import {
  extractPastedImagePaths,
  imageAttachmentFromPath,
  readClipboardImage,
  type PendingImageAttachment,
} from "../image-attachments.js";

export type UseImageAttachArgs = {
  cwd: string;
  setCommandMessage: (message: string | null) => void;
};

export type ImageAttachController = {
  pendingImages: PendingImageAttachment[];
  setPendingImages: Dispatch<SetStateAction<PendingImageAttachment[]>>;
  addPendingImage: (attachment: PendingImageAttachment) => void;
  handlePasteImage: () => void;
  handlePasteText: (text: string) => boolean;
};

export function useImageAttach({ cwd, setCommandMessage }: UseImageAttachArgs): ImageAttachController {
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([]);

  const addPendingImage = (attachment: PendingImageAttachment): void => {
    setPendingImages((prev) => [...prev, attachment]);
    setCommandMessage(`Attached image: ${attachment.name}`);
  };

  const handlePasteImage = (): void => {
    setCommandMessage("Reading clipboard image...");
    void readClipboardImage().then((result) => {
      if (!result.ok) {
        setCommandMessage(`Image paste failed: ${result.reason}`);
        return;
      }
      addPendingImage(result.attachment);
    });
  };

  const handlePasteText = (text: string): boolean => {
    const paths = extractPastedImagePaths(text, cwd);
    if (paths.length === 0) return false;
    setCommandMessage(`Attaching ${paths.length} image${paths.length === 1 ? "" : "s"}...`);
    void Promise.all(paths.map((path) => imageAttachmentFromPath(path))).then((results) => {
      const attached = results.filter((result): result is { ok: true; attachment: PendingImageAttachment } => result.ok);
      const failed = results.length - attached.length;
      if (attached.length > 0) {
        setPendingImages((prev) => [...prev, ...attached.map((result) => result.attachment)]);
      }
      setCommandMessage(
        failed > 0
          ? `Attached ${attached.length} image${attached.length === 1 ? "" : "s"}; ${failed} failed.`
          : `Attached ${attached.length} image${attached.length === 1 ? "" : "s"}.`,
      );
    });
    return true;
  };

  return { pendingImages, setPendingImages, addPendingImage, handlePasteImage, handlePasteText };
}
