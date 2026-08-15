const fs = require('fs');
const path = require('path');

const COMPOSE_SOURCE = fs.readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
const BOOTSTRAP_SOURCE = fs.readFileSync(path.join(__dirname, '../../scripts/fuseki-bootstrap.sh'), 'utf8');

describe('Fuseki runtime scalability contract', () => {
  test('persistent datasets remain explicitly TDB2', () => {
    expect(BOOTSTRAP_SOURCE).toContain('--data-urlencode "dbType=tdb2"');
  });

  test('preserves the image heap default while making it operator-configurable', () => {
    expect(COMPOSE_SOURCE).toContain("JVM_ARGS: '${FUSEKI_JVM_ARGS:--Xmx1200M}'");
  });

  test('healthcheck uses low-cost Fuseki ping rather than an application query', () => {
    expect(COMPOSE_SOURCE).toContain('http://localhost:3030/$$/ping');
    expect(COMPOSE_SOURCE).not.toMatch(/healthcheck:[\s\S]*\/sparql/);
  });

  test('healthcheck stays compatible with BusyBox wget and does not expose credentials', () => {
    expect(COMPOSE_SOURCE).toContain(
      "wget -q -O /dev/null http://localhost:3030/$$/ping || exit 1"
    );
    expect(COMPOSE_SOURCE).not.toMatch(/healthcheck:[\s\S]*--user=/);
    expect(COMPOSE_SOURCE).not.toMatch(/healthcheck:[\s\S]*--password=/);
    expect(COMPOSE_SOURCE).not.toMatch(/healthcheck:[\s\S]*ADMIN_PASSWORD/);
  });
});
