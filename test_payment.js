const http = require('http');

const data = JSON.stringify({
  name: 'Test',
  phone: '1234567890',
  email: 'test@test.com',
  date: '2026-04-12',
  slots: [
    { hour: 6, groundId: 2 },
    { hour: 7, groundId: 2 },
    { hour: 8, groundId: 1 },
    { hour: 9, groundId: 2 },
    { hour: 10, groundId: 1 },
    { hour: 11, groundId: 1 }
  ]
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/payments/create-split-order',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Response:', res.statusCode, body));
});

req.on('error', (e) => console.error(e));
req.write(data);
req.end();
