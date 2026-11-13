import InstrumentLinksTab from '../../../src/pages/InstrumentLinksTab';
import { useInstallation } from '../useInstallation';

/**
 * Analyser Sync & Interfacing.
 *
 * SECHLIMS's own page, imported whole. The note above it is the only thing
 * TransLis adds, and it exists because the page offers four ways to connect
 * and only some of them make sense from where this installation is standing:
 * on an analyser's own PC the instrument writes to a folder on that machine
 * and nothing dials across a network, while on a laboratory network the
 * analyser transmits to this host by its address.
 *
 * Saying which arrangement applies, above the form rather than inside it, is
 * the difference between a page that fits the site and a page the site has to
 * work out for itself.
 */
export default function AnalyserSync() {
  const { installation } = useInstallation();
  const direct = installation?.mode === 'direct';

  return (
    <div className="module-page">
      {installation && (
        <div className="card">
          <div className="section-head"><h3>{installation.modeLabel}</h3></div>
          <p className="hint" style={{ marginTop: 0 }}>
            {direct ? <>
              This computer is the analyser’s own PC. Point a link at the folder the
              instrument software writes to, or at a port on this machine, and the
              results go straight out to {installation.lisName} from here. A serial
              instrument reaches it through a serial-to-Ethernet converter, after which
              it is an ordinary connection on this host.
            </> : <>
              Analysers transmit to this computer across the laboratory network. Give each
              one a port of its own here, set that address and port in the instrument’s
              own service menu, and the results arrive for delivery to {installation.lisName}.
            </>}
          </p>
        </div>
      )}
      <InstrumentLinksTab standalone />
    </div>
  );
}
