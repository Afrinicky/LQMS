import { PowerOff } from 'lucide-react';

export default function DisabledModule() {
  return (
    <div className="module-page">
      <div className="disabled-module">
        <span className="es-ico"><PowerOff size={26} /></span>
        <h3>Module disabled</h3>
        <p>This module is currently turned off by an administrator. Data is preserved, alerts are paused, and the module can be re-enabled from Settings.</p>
      </div>
    </div>
  );
}
