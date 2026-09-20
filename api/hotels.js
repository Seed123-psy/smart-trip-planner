'use strict';
const { searchHotels } = require('../tools/hotels');
const { sendJson, sendError } = require('../tools/http');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
  try { sendJson(res, 200, { hotels: await searchHotels(req.query.city, req.query.keyword) }); }
  catch (error) { sendError(res, error); }
};
