declare module '*.css' {}
interface ImportMeta { env: Record<string, string | undefined>; url: string }

/** Build time, stamped by vite.config.ts. Shown in the status bar. */
declare const __BUILD_STAMP__: string;
/** The product name this bundle was built for. See src/constants/product.ts. */
declare const __PRODUCT_NAME__: string;
