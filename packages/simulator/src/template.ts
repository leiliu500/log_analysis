/**
 * Built-in FRB cashMessage Request/ACK/Response template. Used by the
 * natural-language simulator path when the user's prompt contains no pasted XML
 * — e.g. "simulate 3 request/ack/response with message_id=001 to 003". The
 * messageId/initMessageId are rewritten per set by the simulator.
 */
export const DEFAULT_CASHMESSAGE_SAMPLES = `<ns2:cashMessage xmlns:ns2="http://www.frbsf.org/20130926/cashMessage">
  <version>1.0</version>
  <header>
    <transactionType>USSS</transactionType>
    <messageType>REQUEST</messageType>
    <messageId>FCC-USSS-00000001</messageId>
    <messageSequence>1</messageSequence>
    <sender>FCC</sender>
    <sendTime>2026-06-30T22:14:31.836Z</sendTime>
  </header>
  <payload>
    <cashSecretServiceTransaction>
      <frbOfficeId>1</frbOfficeId>
      <districtId>01</districtId>
      <businessDate>12292025</businessDate>
      <secretServiceRecord>
        <fndenom>20</fndenom>
        <fnserialno>NC39728751F</fnserialno>
        <dpname>M&amp;T Bank- Brinks CT</dpname>
        <adcity>New Britain</adcity>
        <stabbr>CT</stabbr>
        <fnlinitmno>2961</fnlinitmno>
      </secretServiceRecord>
    </cashSecretServiceTransaction>
  </payload>
</ns2:cashMessage>
<NS1:cashMessage xmlns:NS1="http://www.frbsf.org/20130926/cashMessage">
  <version>1.0</version>
  <header>
    <transactionType>USSS</transactionType>
    <messageType>ACK</messageType>
    <messageId>SIM-USSS-00004764</messageId>
    <messageSequence>582</messageSequence>
    <sender>SIM</sender>
    <sendTime>2026-06-30T18:14:49.496Z</sendTime>
  </header>
  <payload>
    <cashAcknowledgement>
      <initTransactionType>USSS</initTransactionType>
      <comment>Success</comment>
      <initMessageId>FCC-USSS-00000001</initMessageId>
      <initMessageSequence>1</initMessageSequence>
      <ackCode>OK</ackCode>
    </cashAcknowledgement>
  </payload>
</NS1:cashMessage>
<NS1:cashMessage xmlns:NS1="http://www.frbsf.org/20130926/cashMessage">
  <version>1.0</version>
  <header>
    <transactionType>USSS</transactionType>
    <messageType>RESPONSE</messageType>
    <messageId>SIM-USSS-00004774</messageId>
    <messageSequence>592</messageSequence>
    <sender>SIM</sender>
    <sendTime>2026-06-30T18:14:50.891Z</sendTime>
  </header>
  <payload>
    <cashAcknowledgement>
      <initTransactionType>USSS</initTransactionType>
      <comment>Success</comment>
      <initMessageId>FCC-USSS-00000001</initMessageId>
      <initMessageSequence>1</initMessageSequence>
      <ackCode>PROCESSED_SUCCESSFULLY</ackCode>
    </cashAcknowledgement>
  </payload>
</NS1:cashMessage>`;
