/**
 * apiflc's default simulator sample — a minimal API Gateway execution-log
 * transaction (one REQUEST + one RESPONSE, correlated by the request id in the
 * "(...)" prefix). Written line-by-line by the verbatim simulator; the request
 * id is freshened per set. Swap `200` for `502` to simulate a failed call.
 */
export const APIFLC_SAMPLE = `(a1b2c3d4-0000-0000-0000-000000000001) Extended Request Id: f3GPZGo-ulQFWZg=
(a1b2c3d4-0000-0000-0000-000000000001) Starting execution for request: a1b2c3d4-0000-0000-0000-000000000001
(a1b2c3d4-0000-0000-0000-000000000001) HTTP Method: GET, Resource Path: /d1/eddReport/exportdetailinternal/121000374/052001633/0520016333300/FF/4/2024-04-01/2024-05-01
(a1b2c3d4-0000-0000-0000-000000000001) Method request path: {officeid_t=121000374, aba_t=052001633, endpoint_t=0520016333300}
(a1b2c3d4-0000-0000-0000-000000000001) Received response. Status: 200, Integration latency: 5639 ms
(a1b2c3d4-0000-0000-0000-000000000001) Method completed with status: 200`;
