import * as fs from 'fs';
import { Answers, prompt } from 'inquirer';
import * as _ from 'lodash';
import * as path from 'path';
import { getPlatformChoices, IArgs } from '../../Constants';
import { exists, matchesContent, patchMatchingFile } from '../../Helper/File';
import { dim, green, l, nl, red } from '../../Helper/Logging';
import { SentryCli } from '../../Helper/SentryCli';
import { MobileProject } from './MobileProject';

const xcode = require('xcode');

export class Cordova extends MobileProject {
  protected sentryCli: SentryCli;
  protected folderPrefix = 'platforms';

  constructor(protected argv: IArgs) {
    super(argv);
    this.sentryCli = new SentryCli(this.argv);
  }

  public async emit(answers: Answers) {
    if (this.argv.uninstall) {
      return this.uninstall(answers);
    }

    const sentryCliProperties = this.sentryCli.convertAnswersToProperties(answers);

    return new Promise(async (resolve, reject) => {
      const promises = this.getPlatforms(answers).map(async (platform: string) => {
        try {
          if (platform === 'ios') {
            await patchMatchingFile(
              `${this.folderPrefix}/ios/*.xcodeproj/project.pbxproj`,
              this.patchXcodeProj.bind(this)
            );
          }
          await this.addSentryProperties(platform, sentryCliProperties);
          green(`Successfully set up ${platform} for cordova`);
        } catch (e) {
          red(e);
        }
      });
      Promise.all(promises)
        .then(resolve)
        .catch(reject);
    });
  }

  public async uninstall(answers: Answers) {
    await patchMatchingFile(
      '**/*.xcodeproj/project.pbxproj',
      this.unpatchXcodeProj.bind(this)
    );

    return {};
  }

  protected async shouldConfigurePlatform(platform: string) {
    let result = false;
    if (!exists(path.join(this.folderPrefix, platform, 'sentry.properties'))) {
      result = true;
      this.debug(`${platform}/sentry.properties not exists`);
    }

    if (!matchesContent('**/*.xcodeproj/project.pbxproj', /sentry-cli/gi)) {
      result = true;
      this.debug('**/*.xcodeproj/project.pbxproj not matched');
    }

    if (this.argv.uninstall) {
      // if we uninstall we need to invert the result so we remove already patched
      // but leave untouched platforms as they are
      return !result;
    }

    return result;
  }

  private unpatchXcodeProj(contents: string, filename: string) {
    const proj = xcode.project(filename);
    return new Promise((resolve, reject) => {
      proj.parse((err: any) => {
        if (err) {
          reject(err);
          return;
        }

        this.unpatchXcodeBuildScripts(proj);
        resolve(proj.writeSync());
      });
    });
  }

  private unpatchXcodeBuildScripts(proj: any) {
    const scripts = proj.hash.project.objects.PBXShellScriptBuildPhase || {};
    const firstTarget = proj.getFirstTarget().uuid;
    const nativeTargets = proj.hash.project.objects.PBXNativeTarget;

    // scripts to kill entirely.
    for (const key of Object.keys(scripts)) {
      const script = scripts[key];

      // ignore comments and keys that got deleted
      if (typeof script === 'string' || script === undefined) {
        continue;
      }

      if (script.shellScript.match(/@sentry\/cli\/bin\/sentry-cli\s+upload-dsym\b/)) {
        delete scripts[key];
        delete scripts[key + '_comment'];
        const phases = nativeTargets[firstTarget].buildPhases;
        if (phases) {
          for (let i = 0; i < phases.length; i++) {
            if (phases[i].value === key) {
              phases.splice(i, 1);
              break;
            }
          }
        }
        continue;
      }
    }
  }

  private patchXcodeProj(contents: string, filename: string) {
    const proj = xcode.project(filename);
    return new Promise((resolve, reject) => {
      proj.parse((err: any) => {
        if (err) {
          reject(err);
          return;
        }

        const buildScripts = [];
        for (const key in proj.hash.project.objects.PBXShellScriptBuildPhase || {}) {
          if (proj.hash.project.objects.PBXShellScriptBuildPhase.hasOwnProperty(key)) {
            const val = proj.hash.project.objects.PBXShellScriptBuildPhase[key];
            if (val.isa) {
              buildScripts.push(val);
            }
          }
        }

        this.addNewXcodeBuildPhaseForSymbols(buildScripts, proj);

        // we always modify the xcode file in memory but we only want to save it
        // in case the user wants configuration for ios.  This is why we check
        // here first if changes are made before we might prompt the platform
        // continue prompt.
        const newContents = proj.writeSync();
        if (newContents === contents) {
          resolve();
        } else {
          resolve(newContents);
        }
      });
    });
  }

  private addNewXcodeBuildPhaseForSymbols(buildScripts: any, proj: any) {
    for (const script of buildScripts) {
      if (script.shellScript.match(/sentry-cli\s+upload-dsym/)) {
        return;
      }
    }

    proj.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      'Upload Debug Symbols to Sentry',
      null,
      {
        shellPath: '/bin/sh',
        shellScript:
          'export SENTRY_PROPERTIES=sentry.properties\\n' +
          '../../plugins/cordova-plugin-sentry/node_modules/@sentry/cli/bin/sentry-cli upload-dsym',
      }
    );
  }

  private addSentryProperties(platform: string, properties: any) {
    let rv = Promise.resolve();
    // This will create the ios/android folder before trying to write
    // sentry.properties in it which would fail otherwise

    if (!fs.existsSync(this.folderPrefix)) {
      dim(`${this.folderPrefix} folder did not exist, creating it.`);
      fs.mkdirSync(this.folderPrefix);
    }
    if (!fs.existsSync(path.join(this.folderPrefix, platform))) {
      dim(`${platform} folder did not exist, creating it.`);
      fs.mkdirSync(path.join(this.folderPrefix, platform));
    }
    const fn = path.join(this.folderPrefix, platform, 'sentry.properties');

    rv = rv.then(() => fs.writeFileSync(fn, this.sentryCli.dumpProperties(properties)));

    return rv;
  }
}
