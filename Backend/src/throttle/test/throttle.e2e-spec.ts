it('should enforce rate limit and return headers', async () => {
  const res = await request(app.getHttpServer()).get('/auth/login');

  expect(res.headers['x-ratelimit-limit']).toBeDefined();
});

it('should return 429 after exceeding limit', async () => {
  for (let i = 0; i < 6; i++) {
    await request(app.getHttpServer()).post('/auth/login');
  }

  const res = await request(app.getHttpServer()).post('/auth/login');
  expect(res.status).toBe(429);
});
