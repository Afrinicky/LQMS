/**
 * What the host calls itself, for the few strings it serves rather than renders.
 *
 * Almost all the naming happens in the browser, where a build-time constant
 * decides it. A handful of labels are sent by the API instead, and those have
 * to be resolved here — by the one host that is running, which knows which
 * product it is because its entry point said so.
 *
 * SECHLIMS sets nothing and gets its own name. The TransLis host sets the
 * variable in its boot module, before any route is mounted.
 */
import { DEFAULT_PRODUCT } from '../../shared/constants/product.js';

export function serverProductName(): string {
  const name = process.env.SECH_LIMS_PRODUCT_NAME;
  return name && name.trim() ? name.trim() : DEFAULT_PRODUCT;
}
