#!/usr/bin/env node
'use strict';

var assert = require('assert');
var _ = require('lodash');
var Path = require('path');
var Promise = require('bluebird');

var URI = require('urijs');
var MimeLookup = require('mime-lookup');
var MIME = new MimeLookup(require('mime-db'));
var exec = require('child_process').execSync;
var jade = require('jade');

var util = require('./util');

var getResourceAsync = Promise.promisify(util.getResource, {multiArgs: true});
var specRootUrl = 'https://apis-guru.github.io/api-models/';

process.on("unhandledRejection", function(reason, promise) {
  process.exitCode = 255;
  //TODO: better solution
  setTimeout(function () { throw reason; });
});

cacheResources()
  .then(function (specs) {
    //Note: at this point all logo are cached
    generateHTML(specs);
    generateAPIsJSON(specs);

    var apiList = generateList(specs);

    generateAPI(apiList);
    return generateBanner(specs, apiList);
  });

function cacheResources(specs) {
  var specs = util.getSpecs('../APIs/');

  return Promise.map(_.values(specs), function (swagger) {
    if (_.isUndefined(swagger.info['x-logo']))
      return swagger;

    var url = swagger.info['x-logo'].url;
    return getResourceAsync(url, {encoding: null})
      .spread(function(response, data) {

        var mime = response.headers['content-type'];
        assert(mime.match('image/'));
        var extension = MIME.extension(mime);
        assert(extension);
        var logoFile = 'cache/' + util.getSwaggerPath(swagger, 'logo.' + extension);
        util.saveFile(logoFile, data);

        var fragment = URI(url).fragment();
        if (fragment)
          fragment = '#' + fragment;

        //Modify object to 
        swagger.info['x-logo'].url = specRootUrl + logoFile + fragment;

        return swagger;
      }, {concurrency: 5});
  });
}

function generateHTML(specs) {
  var locals = {
    specs: _.map(specs, _.ary(util.getSwaggerPath, 1)),
    specRootUrl: specRootUrl
  };

  var template = Path.join(Path.dirname(__filename), '../scripts/index.jade');
  var html = jade.renderFile(template, locals);
  util.saveFile('index.html', html);
}

function generateAPIsJSON(specs) {
  var apisJsonPath = __dirname + '/apis.json'
  var collection = _.extend(util.readJson(apisJsonPath), {
    created: '2015-10-15',
    modified: new Date().toISOString().substring(0, 10),
    url: specRootUrl + 'apis.json',
    apis: []
  });

  _.each(specs, function (swagger) {
    var info = swagger.info;
    collection.apis.push({
      name: info.title,
      description: info.description,
      image: info['x-logo'] && info['x-logo'].url,
      humanURL: swagger.externalDocs && swagger.externalDocs.url,
      baseURL: swagger.schemes[0] + '://' + swagger.host + swagger.basePath,
      version: info.version,
      properties: [{
        type: 'Swagger',
        url: specRootUrl + util.getSwaggerPath(swagger, 'swagger.json')
      }]
    });
  });

  util.saveJson('apis.json', collection);
}

function generateList(specs) {
  var list = {};

  _.each(specs, function (swagger) {
    var id = util.getProviderName(swagger);
    assert(id.indexOf(':') === -1);

    var service = util.getServiceName(swagger);
    if (!_.isUndefined(service)) {
      assert(service.indexOf(':') === -1);
      id += ':' + service;
    }

    var version = swagger.info.version;
    if (_.isUndefined(list[id]))
      list[id] = { versions: {} };

    list[id].versions[version] = swagger;
  });

  _.each(list, function (api, id) {
    if (_.size(api.versions) === 1)
      api.preferred = _.keys(api.versions)[0];
    else {
      _.each(api.versions, function (spec, version) {
        var preferred = spec.info['x-preferred'];
        assert(_.isBoolean(preferred));
        if (preferred) {
          assert(!api.preferred, 'Multiply prefered versions in "' + id + '"');
          api.preferred = version;
        }
      });
    }
  });

  return list;
}

function generateAPI(apiList) {
  var list = {};

  _.each(apiList, function (api, id) {
    var dir = id.replace(/:/, '/');
    list[id] = {
      preferred: api.preferred,
      versions: {}
    };
    _.each(api.versions, function (swagger, version) {
      var filename = util.getSwaggerPath(swagger);
      var swaggerJsonPath = util.getSwaggerPath(swagger, 'swagger.json');

      util.saveYaml(filename, swagger);
      util.saveJson(swaggerJsonPath, swagger);

      var versionObj = list[id].versions[version] = {
        swaggerUrl: specRootUrl + swaggerJsonPath,
        swaggerYamlUrl: specRootUrl + util.getSwaggerPath(swagger),
        info: swagger.info,
        added: gitLogDate('--follow --diff-filter=A', filename).pop(),
        updated: gitLogDate('-1', filename)[0]
      };

      if (swagger.externalDocs)
        versionObj.externalDocs = swagger.externalDocs;
    });
    //FIXME: here we don't track deleted version, not a problem for right now :)
    list[id].added = _(list[id].versions).values().map('added').min();
  });

  console.log('Generated list for ' + _.size(list) + ' API specs.');

  util.saveJson('api/v1/list.json', list);
}

function generateBanner(specs, apiList) {
  var numAPIs = _.size(apiList);
  var numEndpoints = 0;
  _.each(specs, function (swagger) {
    numEndpoints += _.size(swagger.paths);
  });

  return [
    saveShield('APIs in collection' , numAPIs.toString(), 'orange'),
    saveShield('Endpoints', numEndpoints.toString(), 'red')
  ];
}

function gitLogDate(options, filename) {
  var result = exec('git -C .. log --format=%aD ' + options + ' -- \'APIs/' + filename + '\'');
  result = _.trim(result.toString(), '\n');
  assert(result && result !== '');
  result = result.split('\n');
  return result.map(function (str) {
    return new Date(str);
  });
}

function saveShield(subject, status, color) {
  function escape(str) {
    return str.replace(/_/g, '__').replace(/-/g, '--').replace(/ /g, '_');
  }
  function join(left, right) {
    return left + '-' + right;
  }

  var text = join(escape(subject), escape(status));
  var url =  'https://img.shields.io/badge/' + join(text, color) + '.svg';

  return getResourceAsync(url, {encoding: null})
    .spread(function(response, data) {
      var filename = escape(subject).toLowerCase() + '_banner.svg';
      util.saveFile(filename, data);
    });
}