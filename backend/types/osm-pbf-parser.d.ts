declare module 'osm-pbf-parser' {
  import type { Transform } from 'node:stream';

  function parseOsm(): Transform;

  export = parseOsm;
}
