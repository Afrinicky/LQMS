/**
 * What to call this system on screen.
 *
 * The analyser middleware is rendered by two products from one set of files:
 * SECHLIMS, where it is one module of a quality management system, and
 * TransLis, where it is the whole application and goes to facilities that do
 * not run SECHLIMS at all. Prose naming one of them would be wrong in the
 * other, and the laboratory reading "sign in with the usual SECHLIMS account"
 * on a machine with no SECHLIMS on it has been told something untrue.
 *
 * So the name is a build-time constant with one definition per build, and the
 * components say `PRODUCT` where they used to say the word. Nothing else about
 * them changes: SECHLIMS defines it as "SECHLIMS" and renders exactly the text
 * it rendered before this file existed.
 *
 * The fallback is SECHLIMS rather than something neutral, so a build that
 * forgets to define it is the SECHLIMS wording rather than a blank.
 */
declare const __PRODUCT_NAME__: string | undefined;

export const PRODUCT: string =
  typeof __PRODUCT_NAME__ === 'string' && __PRODUCT_NAME__ ? __PRODUCT_NAME__ : 'SECHLIMS';

/** True in the standalone middleware, for the few places that differ in kind. */
export const IS_STANDALONE_MIDDLEWARE = PRODUCT !== 'SECHLIMS';
