let LOGS = global.LOGS || [];

module.exports = (req,res)=>{
  res.json({logs: LOGS});
};
