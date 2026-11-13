/**
 * The product name, where a shared constant has to carry it.
 *
 * Most of the naming is done in the client with a build-time constant
 * (`src/constants/product.ts`). These are the strings that cannot be: label
 * maps in `shared/` are imported by the server as well as by two different
 * renderers, so they hold a placeholder and whoever displays them puts the
 * name in.
 *
 * A placeholder rather than a parameter because these are plain records that
 * are indexed, spread and iterated all over the UI, and turning them into
 * functions would change every one of those sites for a word.
 */
export const PRODUCT_PLACEHOLDER = '{PRODUCT}';

/** The name to use when nothing says otherwise. */
export const DEFAULT_PRODUCT = 'SECHLIMS';

/**
 * Put the product's name into a shared label.
 *
 * Safe on a string that has no placeholder, so it can be applied at a render
 * site without first checking whether that particular label needs it.
 */
export function withProduct(text: string, product: string = DEFAULT_PRODUCT): string {
  return text.split(PRODUCT_PLACEHOLDER).join(product);
}
