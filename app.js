// NYC School Finder - IBM Watson Hackathon Entry - 2015

'use strict';

var express = require('express'),
  app = express(),
  watson = require('watson-developer-cloud'),
  cloudant  = require('cloudant'),
  vcapServices = require('vcap_services'),
  hash = require('string-hash');

// Bootstrap application settings
require('./config/express')(app);

// set config flags for db usage
// the test db only has 99 records for development speed....
app.set('useTestDb', false);

// When running locally make sure you update the credentials below or
// the VCAP_SERVICES.json file
var credentials = {
  pi: {
    username:'<username>',
    password:'<password>',
    version: 'v2'
  },
  ta: {
    username:'<username>',
    password:'<password>',
    version: 'v1'
  },
  cloudant: vcapServices.getCredentials('cloudant')
};

app.persInsights = watson.personality_insights(credentials.pi);
app.tradeoffAnalytics = watson.tradeoff_analytics(credentials.ta);

var analyzer  = require('./lib/school-analyzer')(app);
var finder    = require('./lib/school-finder')(app);
var persUtils = require('./lib/personality-util');

var schooldocs = null;
var ONE_HOUR = 3600000;

// print the arguments
console.log(process.argv.join(' '));

cloudant({
    account:credentials.cloudant.username,
    password:credentials.cloudant.password
  }, function(err, cloudant) {
  if (err)
    return console.log('Error connecting to Cloudant account %s: %s', err.message);

  var dbname = 'schools';
  if (app.get('useTestDb'))
    dbname += '_test';

  console.log('using db:', dbname);
  app.schooldb = cloudant.use(dbname);
  app.tradeoffdb = cloudant.use('tradeoffs');

  // should put a check to see last date of analysis - no for hthon
  // analyzer.run(); // DO NOT RUN ALL THE TIME - set a command-line flag
  if (process.argv.length > 2) {
    if (process.argv[2] === 'analyze') {
      analyzer.run();
    }
    if (process.argv[2] === 'mergePerformance') {
      analyzer.runPerformance();
    }
  } else {
    var updateSchools = function() {
      app.schooldb.list({
        include_docs: true
      }, function(err, _schooldocs) {
        if (err)
          return console.log('Error getting the schools:', err.message);
        else {
          console.log('Updating schools cache with:', _schooldocs.rows.length, ' schools');
          schooldocs = _schooldocs;
        }
      });
    };
    setInterval(updateSchools, ONE_HOUR);
    updateSchools();
  }
});

app.get('/', function(req, res) {
  // get a count of our db records
  if (!app.schooldb || !schooldocs)
    res.render('index', {schoolCount: 435});
  else
    res.render('index', { schoolCount: schooldocs.rows.length });
});

app.post('/student/submit', function(req, res, next){
  console.log('post form:', req.body.studentSample.length);

  // FIRST CHECK OUR HASH if we pre-ran this sample
  var studentSample = req.body.studentSample;
  var sampleHash = hash(studentSample);
  console.log('input sample hash:', sampleHash);
  app.tradeoffdb.get(sampleHash, function(err, data){
    // err will be 404 for no previous run
    if (err && err.statusCode === 404) {
      console.log('no previous run found, running analysis...', studentSample.length);
      app.persInsights.profile({text: studentSample}, function(err, studentPersonality){
        if (err) {
          next(err);
          return;
        }
        console.log('got a student profile');
        console.log('finding matches...');
        // TODO matching algorithm here against all schools
        finder.findSchools(schooldocs, studentPersonality, function(err, matches){
          if (err) {
            next(err);
            return;
          }

          // do some munging on the student top5 compared to schools
          // prepare the tradeoff setup
          finder.tradeoff(matches, function(err, finalMatchData){
            // now returns an object with matches that had enough data to tradeoff analyze...
            // changed to return a cache to the tradeoff result run a separate cloudant db
            if (err) {
              next(err);
              return;
            }
            var tradeoffId = finalMatchData.tradeoffId;

            var results = {
              sampleId: sampleHash, // our future DB id
              isCached: false, // this will get saved - just override when reading
              matches: finalMatchData.matches, // JUST WHAT IS USED IN TRADEOFF PLZ
              tradeoff: '/tradeoff/' + tradeoffId,
              studentPersonality: persUtils.matches(studentPersonality)
            };

            // let's cache? what should we cache really just what we are sending?
            // need fast for demos, just save and forget
            // // FORCE STRING FOR CLOUDANT ID
            app.tradeoffdb.insert(results, sampleHash + '', function(err, ok){
              console.log('cached an analysis run:', err, ok);
            });
            res.json(results); // done sending JSON back
          }); // end tradeoff run
        }); // end school matcher
      }); // end personality profile run

    } else if (data) {
      // we got a cached run!
      console.log('found a cached');
      data.isCached = true;
      res.json(data);
    } else {
      console.log('no cached run and no data, fubar');
      if (err) {
        next(err);
        return;
      }
    }
  });
});

function getTradeoff(req, res){
  // CORS PLZ this is called from the iframe
  console.log('TRADEOFF REQUEST:', req.params.id);
  app.tradeoffdb.get(req.params.id, function(err, tradeoffData){
    res.json(tradeoffData);
  });
}

app.get('/tradeoff/:id', getTradeoff);
app.post('/tradeoff/:id', getTradeoff);


// error-handler settings
require('./config/error-handler')(app);

var port = process.env.VCAP_APP_PORT || 3000;
app.listen(port);
console.log('listening at:', port);
