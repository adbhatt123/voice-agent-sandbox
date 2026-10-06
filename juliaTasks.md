# Open file
cd C:\Users\Julia\voice-agent-sandbox

# Terminal 1
npm run twilio-ivr

# Terminal 2
npx ngrok http 3000

# Terminal 3
Invoke-RestMethod `
  -Uri "http://localhost:3000/start-call" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"to":"+1XXXXXXXXXX"}'

Things to do:

- Change current workflow to fully automated (with no human response) for the medicare cases