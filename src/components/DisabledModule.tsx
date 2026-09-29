import { PowerOff } from 'lucide-react';

export default function DisabledModule() {
  return (
    <div className="module-page">
      <div className="disabled-module">
        <span className="es-ico"><PowerOff size={26} /></span>
        <h3>Module disabled</h3>
      </div>
    </div>
  );
}
