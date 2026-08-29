import type { MessageImagesProps } from '@relay-harness/rlh-client-ui-conversation/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

/** Historical message-image slot entry. */
export function MessageImages({ images, loadImage, align, t }: MessageImagesProps) {
  return <ImageGallery images={images} load={loadImage} align={align} labels={messageImageLabels(t)} />
}
