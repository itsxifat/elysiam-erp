import { ProductImage } from '../../ui/product-image.js';

/**
 * A product photo, as the catalog's own screens show it (M42's interests, M44b's picker), and
 * its large view on a click (D-929).
 */
export function ProductThumb({
  fileId,
  alt,
  size = 'md',
}: {
  readonly fileId: string | null;
  readonly alt: string;
  readonly size?: 'sm' | 'md';
}) {
  return <ProductImage fileId={fileId} alt={alt} size={size} />;
}
