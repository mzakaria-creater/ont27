# PayFuture collector reference mapping

The deployed `payfuture-collector` keeps the provider's numeric `TransactionId`
in our `maven_transactions.tx_id` field and stores the PayFuture invoice in
`merchant_tx_reference`.

The invoice mapping prefers `TxReferenceNumber`, then `TxReferenceNo`, then
`TransactionReference`, with the numeric `TransactionId` as a compatibility
fallback when PayFuture omits the invoice field.

Deployed on 2026-09-03 as Edge Function version 16 in project
`yvwppyoaksyhycimvgtw`.
