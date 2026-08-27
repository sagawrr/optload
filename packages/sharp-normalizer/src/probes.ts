/**
 * Decode probes. Capability claims must be proven by a real pixel decode in
 * the forked child, not by the format table: sharp's official prebuilt
 * libvips parses the HEIF container for any HEIF input but only decodes AV1
 * payloads — HEVC pixels require a libvips built with libde265. The probes
 * below are tiny genuine images (8×8 AV1, 64×48 HEVC) generated once and
 * embedded so the check needs no I/O and stays deterministic.
 */
export const avifProbeBytes = (): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACQAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAgAAAAIAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAsbWRhdBIACgg4CL9pAQ0GkDIWGUJjBMAANAAAkEDJHGFKa47WS8XMYA==',
      'base64',
    ),
  );

export const hevcProbeBytes = (): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOZpcHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAAQAAAADAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAUIEHBjE4h7kWVTcCAgYAgogABAAlEAcBhcshEU2QAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAAuAAAAAW1kYXQAAAAAAAAAPgAAACooAa+i8kaBfMXwI//+Ej7L3wEPsNr/8xQ++bhP/wk0/p/9Pm4HCZqbVH4=',
      'base64',
    ),
  );
