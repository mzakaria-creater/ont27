# OnTarget Gateway API v2

The gateway uses Supabase Postgres as its source of truth. The public API is
served by the Hono gateway and reads/writes the V2 Supabase project with the
server-only secret key. Merchants authenticate with a secret from
`merchant_api_keys`; no Supabase service key is ever sent to a browser.

Base URL: `https://ont27.vercel.app/api/v1/gateway`

## Authentication

Send either `Authorization: Bearer <merchant-secret>` or
`X-API-Secret: <merchant-secret>`. Every mutating request also requires an
`Idempotency-Key` header. The API hashes both secrets and idempotency keys
before comparing/storing them.

## Endpoints

### Create a payment

`POST /payments`

```json
{
  "amount": 150.00,
  "currency": "EGP",
  "payment_method": "mobile_wallet",
  "payment_id": "merchant-order-123",
  "metadata": { "order_id": "123" }
}
```

The response contains the public payment id and the separate lifecycle
statuses: `gateway_status`, `transaction_status`, `business_status`,
`settlement_status`, and `reconciliation_status`.

### Retrieve a payment

`GET /payments/:paymentId`

Returns the payment plus its complete operation history. Sensitive payloads
are not returned by this endpoint.

### Add an operation

`POST /payments/:paymentId/operations`

```json
{ "operation": "capture", "amount": 150.00 }
```

Supported operations: `capture`, `refund`, `payout`, `void`, and `query`.
Refunds are checked against the remaining refundable amount. Every operation
is stored in `transaction_operations` and logged in `gateway_logs`.

### Provider webhook

`POST /webhooks/:provider`

The request must include `X-Gateway-Signature: sha256=<hmac>` where the HMAC
is SHA-256 over the raw request body using the merchant callback secret. The
body should contain `payment_id`, `status`, and optionally
`provider_reference`.

## Provider adapters

The canonical adapter names are `mpgs`, `fawry`, `instapay`, `mobile_wallet`,
`usdt_trc20`, and `bank_transfer`. The current adapter layer normalizes and
records provider identity; actual provider credentials/calls must be added in
the corresponding Railway worker or provider integration before enabling live
capture/refund/payout execution.

## Database objects

- `payment_transactions`: one canonical payment and separate lifecycle states.
- `transaction_operations`: append-only logical operations per payment.
- `gateway_logs`: masked request/response audit entries.
- `payment_idempotency_keys`: replay protection and cached create responses.
- `v_gateway_payment_summary`: safe operational read model.
- `gateway_create_payment(...)`: atomic, idempotent Postgres create primitive.
