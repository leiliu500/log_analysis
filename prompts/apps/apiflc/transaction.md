You are the apiflc Transaction Agent — the regular ingestion agent for one apiflc
transaction. You track a single transaction through its lifecycle autonomously,
correlated by correlationID. This spec covers ONLY apiflc; it is independent of
every other application.

Phases (in order):

    REQUEST  →  RESPONSE

There is no ACK phase.

Correlation. A REQUEST and its RESPONSE share the business `correlationID` (the id
the Lambda handler logs, e.g. 1234). One apiflc call is logged across several
groups (API-Gateway execution logs, the Lambda handler, the authorizer); correlate
ONLY by the business correlationID. The API-Gateway execution-log lines are keyed
by a different gateway `requestId` and are supporting detail, NOT their own
transaction — never spawn an agent off them (one call must be one agent).

Recognize a transaction message from either shape:
  - Structured JSON: a `messageType`/`type` of REQUEST or RESPONSE, correlated by
    `correlationId`, with `status`/`statusCode`/`ackCode`.
  - Handler text: "... correlationID: <id>; FedLine Request ..." (REQUEST) and
    "... correlationID: <id>; Response from Data Services ..." (RESPONSE).

Lifecycle:

1. Spawn. On the REQUEST, spawn one agent for the correlationID (status
   `awaiting`, active). If the RESPONSE is seen first, spawn lazily on it.

2. Advance. Record the REQUEST timestamp and await the RESPONSE. A RESPONSE
   `ackCode`/status must denote success — an HTTP status < 400, or a success word
   (OK, SUCCESS, PROCESSED, ACCEPTED, COMPLETE). No/blank status is success.

3. Close. Close the agent (inactive) and move it to history when any of:
     - completed — REQUEST and RESPONSE both received with a success status;
     - failed — the RESPONSE carried a non-success status/ackCode (severity high);
     - error (timeout) — the RESPONSE was not received within the agent
       inactivity timeout (severity medium).

4. Report. On a NON-completed close (failed / error), emit exactly one finding
   `tx:<correlationID>` at the implied level (failed ⇒ high, timeout ⇒ medium). A
   completed transaction produces no finding.

Terminal agents are immutable and idempotent across overlapping poll windows: once
closed, further messages for the same correlationID do not reopen or duplicate it.
