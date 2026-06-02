import { contextBridge } from 'electron';
contextBridge.exposeInMainWorld('sechLims', { apiBaseUrl: process.env.SECH_LIMS_API_URL ?? 'http://127.0.0.1:4317/api' });
