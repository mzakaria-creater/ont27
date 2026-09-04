# Device SMS forwarding (ont1–ont10)

Use the v2 intake function. Each device must have its own `device_keys` key; keep the raw key only in the device automation app and never commit it.

## Endpoint pattern

`https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/sms-intake?device=ontN&key=DEVICE_KEY`

Replace `ontN` and `DEVICE_KEY` per phone. The function accepts a POST JSON body:

```json
{"device":"ont1","sim":"1","sms":"%SMS_BODY%","sender_number":"%SMS_SENDER%","received_at":"%TIMESTAMP%","event_id":"%MESSAGE_ID%"}
```

Tasker/MacroDroid should only read the incoming SMS and POST it to the matching endpoint. Do not automate Orange Cash sign-in, PIN entry, transfers, or other financial actions. Verification is performed in the OnTarget review queue using the transaction, wallet, amount, and SMS evidence.

## Device list

| Device | URL suffix |
|---|---|
| ont1 | `?device=ont1&key=DEVICE_KEY_1` |
| ont2 | `?device=ont2&key=DEVICE_KEY_2` |
| ont3 | `?device=ont3&key=DEVICE_KEY_3` |
| ont4 | `?device=ont4&key=DEVICE_KEY_4` |
| ont5 | `?device=ont5&key=DEVICE_KEY_5` |
| ont6 | `?device=ont6&key=DEVICE_KEY_6` |
| ont7 | `?device=ont7&key=DEVICE_KEY_7` |
| ont8 | `?device=ont8&key=DEVICE_KEY_8` |
| ont9 | `?device=ont9&key=DEVICE_KEY_9` |
| ont10 | `?device=ont10&key=DEVICE_KEY_10` |

After configuring one device, send a test SMS and confirm it appears under **Device fleet** and **Live SMS** before moving to the next device.
