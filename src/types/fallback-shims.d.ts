// Fallback declarations for restricted/offline environments where npm cannot fetch @types packages.
// package.json still declares the real type packages; these keep foundation checks runnable here.
declare module 'better-sqlite3' { namespace Database { export type Database = any } const Database: any; export default Database; }
declare module 'archiver' { const archiver: any; export default archiver; }
declare module 'cors' { const cors: any; export default cors; }
declare module 'multer' { const multer: any; export default multer; }
declare module 'electron' { export const app: any; export const BrowserWindow: any; export const contextBridge: any; }
// lucide-react ships its own complete TypeScript types (dist/lucide-react.d.ts),
// so no fallback override is declared here — that lets every icon and the
// LucideIcon type resolve from the real package.

declare namespace Express { interface Request { user?: { id: number; username: string; roleId: number; staffId?: number | null } } }
declare module 'express' {
  export type Request = any;
  export type Response = any;
  export type NextFunction = any;
  export type RequestHandler = (...args: any[]) => any;
  export const Router: any;
  const express: any;
  export default express;
}

declare namespace express { export type Request = any; export type Response = any; export type NextFunction = any; }
declare namespace React { export type ReactNode = any; }
declare namespace JSX { interface IntrinsicAttributes { key?: any } }
