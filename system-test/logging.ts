/*!
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {BigQuery} from '@google-cloud/bigquery';
import {PubSub} from '@google-cloud/pubsub';
import {Storage} from '@google-cloud/storage';
import * as assert from 'assert';
import {describe, it} from 'mocha';
import {HOST_ADDRESS} from 'gcp-metadata';
import * as nock from 'nock';
import {Duplex} from 'stream';
import {v4} from 'uuid';
import {after, before} from 'mocha';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http2spy = require('http2spy');
import {Logging, Sink, Log, Entry} from '../src';

// block all attempts to chat with the metadata server (kokoro runs on GCE)
nock(HOST_ADDRESS)
  .get(() => true)
  .replyWithError({code: 'ENOTFOUND'})
  .persist();

describe('Logging', () => {
  const bigQuery = new BigQuery();
  const pubsub = new PubSub();
  const storage = new Storage();
  const logging = new Logging();

  const TESTS_PREFIX = 'nodejs-logging-system-test';
  const WRITE_CONSISTENCY_DELAY_MS = 5000;

  // Create the possible destinations for sinks that we will create.
  const bucket = storage.bucket(generateName());
  const dataset = bigQuery.dataset(generateName().replace(/-/g, '_'));
  const topic = pubsub.topic(generateName());

  let PROJECT_ID: string;
  before(async () => {
    const serviceAccount = (await logging.auth.getCredentials()).client_email;
    PROJECT_ID = await logging.auth.getProjectId();
    await bucket.create();
    await bucket.iam.setPolicy({
      bindings: [
        {
          role: 'roles/storage.admin',
          members: [`serviceAccount:${serviceAccount}`],
        },
      ],
    });
    await dataset.create();
    await topic.create();
  });

  after(async () => {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    await Promise.all([
      deleteBuckets(),
      deleteDatasets(),
      deleteTopics(),
      deleteSinks(),
    ]);

    async function deleteBuckets() {
      const [buckets] = await storage.getBuckets({prefix: TESTS_PREFIX});
      const bucketsToDelete = buckets.filter(bucket => {
        return new Date(bucket.metadata.timeCreated) < oneHourAgo;
      });

      for (const bucket of bucketsToDelete) {
        await bucket.deleteFiles();
        await bucket.delete();
      }
    }

    async function deleteDatasets() {
      await getAndDelete(bigQuery.getDatasets.bind(bigQuery));
    }

    async function deleteTopics() {
      await getAndDelete(pubsub.getTopics.bind(pubsub));
    }

    async function deleteSinks() {
      await getAndDelete(logging.getSinks.bind(logging));
    }

    async function getAndDelete(method: Function) {
      const [objects] = await method();
      return Promise.all(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (objects as any[])
          .filter(o => {
            const name = o.name || o.id;
            if (!name.startsWith(TESTS_PREFIX)) {
              return false;
            }
            return getDateFromGeneratedName(name) < oneHourAgo;
          })
          .map(o => o.delete())
      );
    }
  });

  describe('sinks', () => {
    it('should create a sink with a Bucket destination', async () => {
      const sink = logging.sink(generateName());
      const [, apiResponse] = await sink.create({
        destination: bucket,
      });
      const destination = 'storage.googleapis.com/' + bucket.name;
      assert.strictEqual(apiResponse.destination, destination);
    });

    it('should create a sink with a Dataset destination', async () => {
      const sink = logging.sink(generateName());
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [_, apiResponse] = await sink.create({destination: dataset});

      const destination = `bigquery.googleapis.com/datasets/${dataset.id}`;

      // The projectId may have been replaced depending on how the system
      // tests are being run, so let's not care about that.
      apiResponse.destination = apiResponse.destination!.replace(
        /projects\/[^/]*\//,
        ''
      );
      assert.strictEqual(apiResponse.destination, destination);
    });

    it('should create a sink with a Topic destination', async () => {
      const sink = logging.sink(generateName());
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [_, apiResponse] = await sink.create({destination: topic});
      const destination = 'pubsub.googleapis.com/' + topic.name;

      // The projectId may have been replaced depending on how the system
      // tests are being run, so let's not care about that.
      assert.strictEqual(
        apiResponse.destination!.replace(/projects\/[^/]*\//, ''),
        destination.replace(/projects\/[^/]*\//, '')
      );
    });

    describe('metadata', () => {
      const sink = logging.sink(generateName());
      const FILTER = 'severity = ALERT';

      before(async () => {
        await sink.create({destination: topic});
      });

      it('should set metadata', async () => {
        const metadata = {filter: FILTER};
        const [apiResponse] = await sink.setMetadata(metadata);
        assert.strictEqual(apiResponse.filter, FILTER);
      });

      it('should set a filter', async () => {
        const [apiResponse] = await sink.setFilter(FILTER);
        assert.strictEqual(apiResponse.filter, FILTER);
      });
    });

    describe('listing sinks', () => {
      const sink = logging.sink(generateName());

      before(async () => {
        await sink.create({destination: topic});
      });

      it('should list sinks', async () => {
        const [sinks] = await logging.getSinks();
        assert(sinks.length > 0);
      });

      it('should list sinks as a stream', done => {
        const logstream: Duplex = logging
          .getSinksStream({pageSize: 1})
          .on('error', done)
          .once('data', () => {
            logstream.end();
            done();
          });
      });

      it('should get metadata', done => {
        logging
          .getSinksStream({pageSize: 1})
          .on('error', done)
          .once('data', (sink: Sink) => {
            sink.getMetadata((err, metadata) => {
              assert.ifError(err);
              assert.strictEqual(typeof metadata, 'object');
              done();
            });
          });
      });
    });
  });

  describe('logs', () => {
    function getTestLog(loggingInstnce = null) {
      const log = (loggingInstnce || logging).log(generateName());

      const logEntries = [
        // string data
        log.entry('log entry 1'),

        // object data
        log.entry({delegate: 'my_username'}),

        // various data types
        log.entry({
          nonValue: null,
          boolValue: true,
          arrayValue: [1, 2, 3],
        }),

        // nested object data
        log.entry({
          nested: {
            delegate: 'my_username',
          },
        }),
      ];

      return {log, logEntries};
    }

    function getEntriesFromLog(
      log: Log,
      config: {numExpectedMessages: number},
      callback: (err: Error | null, entries?: Entry[]) => void
    ) {
      let numAttempts = 0;

      const numExpectedMessages = config.numExpectedMessages;

      setTimeout(pollForMessages, WRITE_CONSISTENCY_DELAY_MS);

      function pollForMessages() {
        numAttempts++;

        const time = new Date();
        time.setHours(time.getHours() - 1);

        log.getEntries(
          {autoPaginate: false, filter: `timestamp > "${time.toISOString()}"`},
          (err, entries) => {
            if (err) {
              callback(err);
              return;
            }

            if (entries!.length < numExpectedMessages && numAttempts < 8) {
              setTimeout(pollForMessages, WRITE_CONSISTENCY_DELAY_MS);
              return;
            }

            callback(null, entries);
          }
        );
      }
    }

    const options = {
      resource: {
        type: 'gce_instance',
        labels: {
          zone: 'global',
          instance_id: '3',
        },
      },
    };

    describe('listing logs', () => {
      before(async () => {
        const {log, logEntries} = getTestLog();
        await log.write(logEntries, options);
      });

      it('should list logs', async () => {
        const [logs] = await logging.getLogs();
        assert(logs.length > 0);
      });

      it('should list logs as a stream', done => {
        const stream: Duplex = logging
          .getLogsStream({pageSize: 1})
          .on('error', done)
          .once('data', () => {
            stream.end();
            done();
          });
      });
    });

    it('should list log entries', done => {
      const {log, logEntries} = getTestLog();

      log.write(logEntries, options, err => {
        assert.ifError(err);

        getEntriesFromLog(
          log,
          {numExpectedMessages: logEntries.length},
          (err, entries) => {
            assert.ifError(err);
            assert.strictEqual(entries!.length, logEntries.length);
            done();
          }
        );
      });
    });

    it('should list log entries as a stream', done => {
      const {log, logEntries} = getTestLog();

      log.write(logEntries, options, err => {
        assert.ifError(err);

        const logstream: Duplex = logging
          .getEntriesStream({
            autoPaginate: false,
            pageSize: 1,
          })
          .on('error', done)
          .once('data', () => logstream.end())
          .on('end', done);
      });
    });

    describe('log-specific entries', () => {
      let logExpected: Log;
      let logEntriesExpected: Entry[];

      before(done => {
        const {log, logEntries} = getTestLog();
        logExpected = log;
        logEntriesExpected = logEntries;
        log.write(logEntries, options, done);
      });

      it('should list log entries', done => {
        getEntriesFromLog(
          logExpected,
          {numExpectedMessages: logEntriesExpected.length},
          (err, entries) => {
            assert.ifError(err);
            assert.strictEqual(entries!.length, logEntriesExpected.length);
            done();
          }
        );
      });

      it('should list log entries as a stream', done => {
        const logstream = logExpected
          .getEntriesStream({
            autoPaginate: false,
            pageSize: 1,
          })
          .on('error', done)
          .once('data', () => {
            logstream.end();
            done();
          });
      });
    });

    it('should write a single entry to a log', done => {
      const {log, logEntries} = getTestLog();
      log.write(logEntries[0], options, done);
    });

    it('should write a single entry to a log as a Promise', async () => {
      const {log, logEntries} = getTestLog();
      await log.write(logEntries[1], options);
    });

    // TODO(bcoe): this appears to be an actual regression with the API that
    // we need to dig into `nonValue` is either not being written, or not being
    // read appropriately from the API:
    it.skip('should write multiple entries to a log', done => {
      const {log, logEntries} = getTestLog();

      log.write(logEntries, options, err => {
        assert.ifError(err);

        getEntriesFromLog(
          log,
          {numExpectedMessages: logEntries.length},
          (err, entries) => {
            assert.ifError(err);

            assert.deepStrictEqual(entries!.map(x => x.data).reverse(), [
              'log entry 1',
              {delegate: 'my_username'},
              {
                nonValue: null,
                boolValue: true,
                arrayValue: [1, 2, 3],
              },
              {
                nested: {
                  delegate: 'my_username',
                },
              },
            ]);

            done();
          }
        );
      });
    });

    it('should preserve order of entries', done => {
      const {log} = getTestLog();

      const entry1 = log.entry('1');

      setTimeout(() => {
        const entry2 = log.entry('2');
        const entry3 = log.entry({timestamp: entry2.metadata.timestamp}, '3');

        // Re-arrange to confirm the timestamp is sent and honored.
        log.write([entry2, entry3, entry1], options, err => {
          assert.ifError(err);

          getEntriesFromLog(log, {numExpectedMessages: 3}, (err, entries) => {
            assert.ifError(err);
            assert.deepStrictEqual(
              entries!.map(x => x.data),
              ['3', '2', '1']
            );
            done();
          });
        });
      }, 1000);
    });

    it('should preserve order for sequential write calls', done => {
      const {log} = getTestLog();
      const messages = ['1', '2', '3', '4', '5'];

      (async () => {
        for (const message of messages) {
          await log.write(log.entry(message), options);
        }

        getEntriesFromLog(
          log,
          {numExpectedMessages: messages.length},
          (err, entries) => {
            assert.ifError(err);
            assert.deepStrictEqual(
              entries!.reverse().map(x => x.data),
              messages
            );
            done();
          }
        );
      })();
    });

    it('should write an entry with primitive values', done => {
      const {log} = getTestLog();

      const logEntry = log.entry({
        when: new Date(),
        matchUser: /username: (.+)/,
        matchUserError: new Error('No user found.'),
        shouldNotBeSaved: undefined,
      });

      log.write(logEntry, options, err => {
        assert.ifError(err);

        getEntriesFromLog(log, {numExpectedMessages: 1}, (err, entries) => {
          assert.ifError(err);

          const entry = entries![0];

          assert.deepStrictEqual(entry.data, {
            when: logEntry.data.when.toString(),
            matchUser: logEntry.data.matchUser.toString(),
            matchUserError: logEntry.data.matchUserError.toString(),
          });

          done();
        });
      });
    });

    it('should write a log with metadata', done => {
      const {log} = getTestLog();

      const metadata = Object.assign({}, options, {
        severity: 'DEBUG',
      });

      const data = {
        embeddedData: true,
      };

      const logEntry = log.entry(metadata, data);

      log.write(logEntry, err => {
        assert.ifError(err);

        getEntriesFromLog(log, {numExpectedMessages: 1}, (err, entries) => {
          assert.ifError(err);

          const entry = entries![0];
          assert.strictEqual(entry.metadata.severity, metadata.severity);
          assert.deepStrictEqual(entry.data, data);
          done();
        });
      });
    });

    it('should set the default resource', done => {
      const {log} = getTestLog();

      const text = 'entry-text';
      const entry = log.entry(text);

      log.write(entry, err => {
        assert.ifError(err);

        getEntriesFromLog(log, {numExpectedMessages: 1}, (err, entries) => {
          assert.ifError(err);
          const entry = entries![0];

          assert.strictEqual(entry.data, text);
          assert.deepStrictEqual(entry.metadata.resource, {
            type: 'global',
            labels: {
              project_id: PROJECT_ID,
            },
          });

          done();
        });
      });
    });

    it('should write a log with camelcase resource label keys', done => {
      const {log, logEntries} = getTestLog();
      log.write(
        logEntries,
        {
          resource: {
            type: 'gce_instance',
            labels: {
              zone: 'global',
              instanceId: '3',
            },
          },
        },
        done
      );
    });

    it('should write to a log with alert helper', done => {
      const {log, logEntries} = getTestLog();
      log.alert(logEntries, options, done);
    });

    it('should write to a log with critical helper', done => {
      const {log, logEntries} = getTestLog();
      log.critical(logEntries, options, done);
    });

    it('should write to a log with debug helper', done => {
      const {log, logEntries} = getTestLog();
      log.debug(logEntries, options, done);
    });

    it('should write to a log with emergency helper', done => {
      const {log, logEntries} = getTestLog();
      log.emergency(logEntries, options, done);
    });

    it('should write to a log with error helper', done => {
      const {log, logEntries} = getTestLog();
      log.error(logEntries, options, done);
    });

    it('should write to a log with info helper', done => {
      const {log, logEntries} = getTestLog();
      log.info(logEntries, options, done);
    });

    it('should write to a log with notice helper', done => {
      const {log, logEntries} = getTestLog();
      log.notice(logEntries, options, done);
    });

    it('should write to a log with warning helper', done => {
      const {log, logEntries} = getTestLog();
      log.warning(logEntries, options, done);
    });

    it('should populate x-goog-api-client header', async () => {
      const {Logging} = http2spy.require(require.resolve('../src'));
      const {log, logEntries} = getTestLog(new Logging());
      await log.write(logEntries[0], options);
      assert.ok(
        /gax\/[0-9]+\.[\w.-]+ gapic\/[0-9]+\.[\w.-]+ gl-node\/[0-9]+\.[\w.-]+ grpc\/[0-9]+\.[\w.-]+ gccl\/[0-9]+\.[\w.-]+/.test(
          http2spy.requests[0]['x-goog-api-client'][0]
        )
      );
    });
  });

  function generateName() {
    return `${TESTS_PREFIX}-${Date.now()}-${v4().split('-').pop()}`;
  }

  // Parse the time the resource was created using the resource id
  // Format 1: ${TESTS_PREFIX}-${date}-${uuid}
  // Format 2: ${TESTS_PREFIX}_${date}_${uuid}
  function getDateFromGeneratedName(name: string) {
    const timeCreated = name.substr(TESTS_PREFIX.length + 1).split(/-|_/g)[0];
    return new Date(Number(timeCreated));
  }
});
