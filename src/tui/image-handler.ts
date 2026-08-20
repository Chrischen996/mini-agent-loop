import type { Dispatch } from "react";
import type { TuiAction, ImageAttachment } from "./state.ts";
import { loadImageAttachment, readClipboardImage, MAX_TUI_IMAGES } from "./image-attachments.ts";

export type ImageHandlerDeps = {
  pendingImages: ImageAttachment[];
  pendingImagesRef: { current: ImageAttachment[] };
  dispatch: Dispatch<TuiAction>;
  cwd: string;
};

/**
 * Add a pending image to the attachment list.
 */
export function addPendingImage(image: ImageAttachment, deps: ImageHandlerDeps): boolean {
  const { pendingImages, dispatch, pendingImagesRef } = deps;

  if (pendingImages.some((item) => item.path === image.path)) return true;

  if (pendingImages.length >= MAX_TUI_IMAGES) {
    dispatch({
      type: "ATTACHMENT_ERROR",
      message: `最多可同时添加 ${MAX_TUI_IMAGES} 张图片`,
    });
    return false;
  }

  pendingImagesRef.current = [...pendingImages, image];
  dispatch({ type: "ADD_PENDING_IMAGE", image });
  return true;
}

/**
 * Read an image from clipboard and add it as a pending attachment.
 */
export async function handlePasteImage(deps: ImageHandlerDeps): Promise<boolean> {
  try {
    const image = await readClipboardImage();
    return addPendingImage(image, deps);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.dispatch({
      type: "ATTACHMENT_ERROR",
      message: `无法粘贴图片: ${detail}`,
    });
    return false;
  }
}
