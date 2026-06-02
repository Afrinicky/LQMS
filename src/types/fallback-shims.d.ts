// Fallback declarations for restricted/offline environments where npm cannot fetch @types packages.
// package.json still declares the real type packages; these keep foundation checks runnable here.
declare module 'better-sqlite3' { namespace Database { export type Database = any } const Database: any; export default Database; }
declare module 'archiver' { const archiver: any; export default archiver; }
declare module 'cors' { const cors: any; export default cors; }
declare module 'multer' { const multer: any; export default multer; }
declare module 'electron' { export const app: any; export const BrowserWindow: any; export const contextBridge: any; }
declare module 'lucide-react' { export const Bell: any; export const Database: any; export const Server: any; export const Shield: any; }

declare namespace Express { interface Request { user?: { id: number; username: string; roleId: number } } }
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
