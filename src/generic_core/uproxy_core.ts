import * as bridge from '../lib/bridge/bridge';
import * as globals from './globals';
import * as constants from './constants';
import * as _ from 'lodash';
import * as key_verify from './key-verify';
import * as logging from '../lib/logging/logging';
import * as loggingTypes from '../lib/loggingprovider/loggingprovider.types';
import * as net from '../lib/net/net.types';
import * as nat_probe from '../lib/nat/probe';
import * as remote_connection from './remote-connection';
import * as remote_instance from './remote-instance';
import * as remote_user from './remote-user';
import * as user from './remote-user';
import * as social_network from './social';
import * as social from '../interfaces/social';
import * as socks from '../lib/socks/headers';
import StoredValue from './stored_value';
import * as tcp from '../lib/net/tcp';
import * as ui_connector from './ui_connector';
import * as uproxy_core_api from '../interfaces/uproxy_core_api';
import * as version from '../generic/version';
import * as freedomXhr from 'freedom-xhr';

import ui = ui_connector.connector;
import storage = globals.storage;

declare var freedom: freedom.FreedomInModuleEnv;

var log :logging.Log = new logging.Log('core');
log.info('Loading core', version.UPROXY_VERSION);

// Note that the proxy runs extremely slowly in debug ('*:D') mode.
export var loggingController = freedom['loggingcontroller']();
loggingController.setDefaultFilter(
    loggingTypes.Destination.console,
    loggingTypes.Level.warn);
loggingController.setDefaultFilter(
    loggingTypes.Destination.buffered,
    loggingTypes.Level.debug);

var portControl = globals.portControl;

// Prefix for freedomjs modules which interface with cloud computing providers.
const CLOUD_PROVIDER_MODULE_NAME_PREFIX: string = 'CLOUDPROVIDER-';
const CLOUD_PROVIDER_NAME = 'digitalocean';
const CLOUD_PROVIDER_MODULE_NAME = CLOUD_PROVIDER_MODULE_NAME_PREFIX + CLOUD_PROVIDER_NAME;
const CLOUD_INSTALLER_MODULE_NAME = 'cloudinstall';

const getCloudProviderNames = (): string[] => {
  let results: string[] = [];
  for (var dependency in freedom) {
    if (freedom.hasOwnProperty(dependency) &&
        dependency.indexOf(CLOUD_PROVIDER_MODULE_NAME_PREFIX) === 0) {
      results.push(dependency.substr(CLOUD_PROVIDER_MODULE_NAME_PREFIX.length));
    }
  }
  return results;
};

// This is the name recommended by the blog post.
const CLOUD_DROPLET_NAME = 'uproxy-cloud-server';

// Percentage of cloud install progress devoted to deploying.
// The remainder is devoted to the install script.
const CLOUD_DEPLOY_PROGRESS = 20;

// Invokes f with an instance of the specified freedomjs module.
// The module instance will be destroyed before the function resolves
// or rejects. Intended for use with heavy-weight modules such as
// those used for cloud.
function oneShotModule_<T>(moduleName: string, f: (provider: any) => Promise<T>): Promise<T> {
  try {
    const m = freedom[moduleName]();
    log.debug('created ' + moduleName + ' module');

    const destructor = () => {
      try {
        freedom[moduleName].close(m);
        log.debug('destroyed ' + moduleName + ' module');
      } catch (e) {
        log.debug('error destroying ' + moduleName + ' module: ' + e.message);
      }
    };

    try {
      return f(m).then((result: T) => {
        destructor();
        return result;
      }, (e: Error) => {
        destructor();
        throw e;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  } catch (e) {
    return Promise.reject(new Error('error creating ' + moduleName + ' module: ' + e.message));
  }
}

/**
 * Primary uProxy backend. Handles which social networks one is connected to,
 * sends updates to the UI, and handles commands from the UI.
 */
export class uProxyCore implements uproxy_core_api.CoreApi {

  // this should be set iff an update to the core is available
  private availableVersion_ :string = null;

  private connectedNetworks_ = new StoredValue<string[]>('connectedNetworks', []);

  constructor() {
    log.debug('Preparing uProxy Core');

    this.refreshPortControlSupport();

    globals.loadSettings.then(() => {
      return this.connectedNetworks_.get();
    }).then((networks :string[]) => {
      var logins :Promise<void>[] = [];

      for (var i in networks) {
        var networkName = networks[i]
        if (!(networkName in social_network.networks)) {
          // Network may have been removed, e.g. old "Facebook" network is now
          // "Facebook-Firebase-V2".
          continue;
        }
        logins.push(this.login({
          network: networkName,
          loginType: uproxy_core_api.LoginType.RECONNECT
        }).catch(() => {
          // any failure to login should just be ignored - the user will either
          // be logged in with just some accounts or still on the login screen
          return;
        }));

        // at this point, clear all networks; those that successfully get logged
        // in will be re-added
        this.connectedNetworks_.set([]);
      }

      // this return is meaningless, but it may be useful in the future
      return Promise.all(logins);
    }).then(() => {
      log.info('Finished handling reconnections');
    });
  }

  // sendInstanceHandshakeMessage = (clientId :string) => {
  //   // TODO: Possibly implement this, or get rid of the possibility for
  //   // UI-initiated instance handshakes.
  // }

  changeOption = (option :string) => {
    // TODO: implement options.
  }

  dismissNotification = (instancePath :social.InstancePath) => {
    // TODO: implement options.
  }

  private pendingNetworks_ :{[name :string] :social.Network} = {};
  private portControlSupport_ = uproxy_core_api.PortControlSupport.PENDING;

  /**
   * Access various social networks using the Social API.
   */
  public login = (loginArgs :uproxy_core_api.LoginArgs) :Promise<uproxy_core_api.LoginResult> => {
    var networkName = loginArgs.network;

    if (!(networkName in social_network.networks)) {
      log.warn('Network does not exist', networkName);
      return Promise.reject(new Error('Network does not exist (' + networkName + ')'));
    }

    var network = this.pendingNetworks_[networkName];
    if (typeof network === 'undefined') {
      network = new social_network.FreedomNetwork(networkName, globals.metrics);
      this.pendingNetworks_[networkName] = network;
    }

    return network.login(loginArgs.loginType, loginArgs.userName).then(() => {
      delete this.pendingNetworks_[networkName];
      log.info('Successfully logged in to network', {
        network: networkName,
        userId: network.myInstance.userId
      });

      // Save network to storage so we can reconnect on restart.
      return this.connectedNetworks_.get().then((networks :string[]) => {
        if (_.includes(networks, networkName)) {
          return;
        }
        networks.push(networkName);
        return this.connectedNetworks_.set(networks);
      }).catch((e) => {
        console.warn('Could not save connected networks', e);
      }).then(() => {
        // Fulfill login's returned promise with uproxy_core_api.LoginResult.
        return {
          userId: network.myInstance.userId,
          instanceId: network.myInstance.instanceId
        }
      });
    }, (e) => {
      delete this.pendingNetworks_[networkName];
      throw e;
    });
  }

  /**
   * Log-out of |networkName|.
   * TODO: write a test for this.
   */
  public logout = (networkInfo :social.SocialNetworkInfo) : Promise<void> => {
    var networkName = networkInfo.name;
    if (networkInfo.userId) {
      const userId = networkInfo.userId;
      var network = social_network.getNetwork(networkName, userId);
    } else {
      var network = this.getNetworkByName_(networkName);
    }

    if (null === network) {
      log.warn('Could not logout of network', networkName);
      return;
    } else if (network.name === 'Cloud') {
      log.error('Cannot logout from Cloud');
      return Promise.reject(new Error('Cannot logout from Cloud'));
    }

    return network.logout().then(() => {
      log.info('Successfully logged out of network', networkName);

      return this.connectedNetworks_.get().then((networks) => {
        return this.connectedNetworks_.set(_.without(networks, networkName));
      }).catch((e) => {
        log.warn('Could not remove network from list of connected networks', e);
        // we will probably not be able to log back in anyways, ignore this
        return;
      });
    });
  }

  // onUpdate not needed in the real core.
  onUpdate = (update:uproxy_core_api.Update, handler:Function) => {
    throw 'uproxy_core onUpdate not implemented.';
  }

  public updateGlobalSetting = (change: uproxy_core_api.UpdateGlobalSettingArgs) => {
    // Make sure we have the correct settings object loaded and aren't
    // going to write over something we should not
    globals.loadSettings.then(() => {
      (<any>globals.settings)[change.name] = change.value;

      // We could try to speed things up slightly by just manually calling the
      // save here, but that seems like an unnecessary optimization for something
      // that should not be called that often
      this.updateGlobalSettings(globals.settings);
    });
  }

  /**
   * Updates user's description of their current device. This applies to all
   * local instances for every network the user is currently logged onto. Those
   * local instances will then propogate their description update to all
   * instances.
   */
  public updateGlobalSettings = (newSettings :uproxy_core_api.GlobalSettings) => {
    newSettings.version = constants.STORAGE_VERSION;
    if (newSettings.stunServers.length === 0) {
      newSettings.stunServers = constants.DEFAULT_STUN_SERVERS;
    }
    var oldDescription = globals.settings.description;
    globals.storage.save('globalSettings', newSettings)
      .catch((e) => {
        log.error('Could not save globalSettings to storage', e.stack);
      });

    _.merge(globals.settings, newSettings, (a :Object, b :Object) => {
        // ensure we do not merge the arrays and that the reference remains intact
        if (_.isArray(a) && _.isArray(b)) {
          var arrayA = <Object[]>a;
          arrayA.splice(0, arrayA.length);
          var arrayB = <Object[]>b;
          for (var i in b) {
            arrayA.push(arrayB[parseInt(i)]);
          }
          return a;
        }

        // this causes us to fall back to the default merge behaviour
        return undefined;
    });

    if (globals.settings.description !== oldDescription) {
      // Resend instance info to update description for logged in networks.
      for (var networkName in social_network.networks) {
        for (var userId in social_network.networks[networkName]) {
          social_network.networks[networkName][userId].resendInstanceHandshakes();
        }
      }
    }

    loggingController.setDefaultFilter(
      loggingTypes.Destination.console,
      globals.settings.consoleFilter);
  }

  public getFullState = () :Promise<uproxy_core_api.InitialState> => {
    return globals.loadSettings.then(() => {

      let moveToFront = (array :string[], element :string) :void => {
        let i = array.indexOf(element);
        if (i < 1) {
          return;
        }
        array.splice(0, 0, array.splice(i, 1)[0] );
      };

      let networkNames = Object.keys(social_network.networks);

      for (let name of ['Quiver', 'Cloud']) {
        if (name in social_network.networks) {
          moveToFront(networkNames, name);
        }
      }

      return {
        networkNames: networkNames,
        cloudProviderNames: getCloudProviderNames(),
        globalSettings: globals.settings,
        onlineNetworks: social_network.getOnlineNetworks(),
        availableVersion: this.availableVersion_,
        portControlSupport: this.portControlSupport_,
      };
    });
  }

  /**
   * Modifies the local consent value as the result of a local user action.
   * This is a distinct pathway from receiving consent bits over the wire, which
   * is handled directly inside the relevant social.Network.
   */
  public modifyConsent = (command:uproxy_core_api.ConsentCommand) => {
    // Determine which Network, User, and Instance...
    var user = this.getUser(command.path);
    if (!user) {  // Error msg emitted above.
      log.error('Cannot modify consent for non-existing user', command.path);
      return;
    }
    // Set the instance's new consent levels. It will take care of sending new
    // consent bits over the wire and re-syncing with the UI.
    user.modifyConsent(command.action);
  }

  public inviteGitHubUser = (data :uproxy_core_api.CreateInviteArgs): Promise<void> => {
    var network = social_network.networks[data.network.name][data.network.userId];
    return network.inviteGitHubUser(data);
  }

  public acceptInvitation = (data :uproxy_core_api.AcceptInvitationData) : Promise<void> => {
    var networkName = data.network.name;
    var networkUserId = data.network.userId;
    if (!networkUserId) {
      // Take the first key in the userId to social network map as the current user.
      // Assumes the user is only signed in once to any given network.
      networkUserId = Object.keys(social_network.networks[networkName])[0];
    }
    var network = social_network.getNetwork(networkName, networkUserId);
    return network.acceptInvitation(data.tokenObj, data.userId);
  }

  public getInviteUrl = (data :uproxy_core_api.CreateInviteArgs): Promise<string> => {
    var network = social_network.networks[data.network.name][data.network.userId];
    return network.getInviteUrl(data);
  }

  public sendEmail = (data :uproxy_core_api.EmailData) : void => {
    var networkInfo = data.networkInfo;
    var network = social_network.networks[networkInfo.name][networkInfo.userId];
    network.sendEmail(data.to, data.subject, data.body);
  }

  public postReport = (args :uproxy_core_api.PostReportArgs) : Promise<void> => {
    let host = 'd1wtwocg4wx1ih.cloudfront.net';
    let front = 'https://a0.awsstatic.com/';
    let request:XMLHttpRequest = new freedomXhr.auto();
    return new Promise<any>((F, R) => {
      request.onload = F;
      request.onerror = R;
      // Only the front domain is exposed on the wire. The host and path
      // should be encrypted. The path needs to be here and not
      // in the Host header, which can only take a host name.
      request.open('POST', front + args.path, true);
      // The true destination address is set as the Host in the header.
      request.setRequestHeader('Host', host);
      request.send(JSON.stringify(args.payload));
    });
  }

  /**
   * Begin using a peer as a proxy server.
   * Starts SDP negotiations with a remote peer. Assumes |path| to the
   * RemoteInstance exists.
   */
  public start = (path :social.InstancePath) : Promise<net.Endpoint> => {
    var remote = this.getInstance(path);
    if (!remote) {
      log.error('Instance does not exist for proxying', path.instanceId);
      return Promise.reject(new Error('Instance does not exist for proxying (' + path.instanceId + ')'));
    }
    // Remember this instance as our proxy.  Set this before start fulfills
    // in case the user decides to cancel the proxy before it begins.
    return remote.start();
  }

  /**
   * Stop proxying with the current instance, if it exists.
   */
  public stop = (path :social.InstancePath) => {
    var remote = this.getInstance(path);
    if (!remote) {
      log.error('Instance does not exist for proxying', path.instanceId);
      return Promise.reject(new Error('Instance does not exist for proxying (' + path.instanceId + ')'));
    }
    remote.stop();
    // TODO: Handle revoked permissions notifications.
  }

  /**
   * Obtain the RemoteInstance corresponding to an instance path.
   */
  public getInstance = (path :social.InstancePath) :social.RemoteUserInstance => {
    var user = this.getUser(path);
    if (!user) {
      log.error('No user', path.userId);
      return;
    }
    return user.getInstance(path.instanceId);
  }

  public getUser = (path :social.UserPath) :social.RemoteUser => {
    var network = social_network.getNetwork(path.network.name, path.network.userId);
    if (!network) {
      log.error('No network', path.network.name);
      return;
    }
    return network.getUser(path.userId);
  }

  // If the user requests the NAT type while another NAT request is pending,
  // the then() block of doNatProvoking ends up being called twice.
  // We keep track of the timeout that resets the NAT type to make sure
  // there is at most one timeout at a time.
  private natResetTimeout_ :NodeJS.Timer;

  public getNatType = () :Promise<string> => {
    if (globals.natType === '') {
      // Function that returns a promise which fulfills
      // in a given time.
      var countdown = (time:number) : Promise<void> => {
        return new Promise<void>((F, R) => {
          setTimeout(F, time);
        });
      }

      // Return the first Promise that fulfills in the 'race'
      // between a countdown and NAT provoking.
      // i.e., if NAT provoking takes longer than 30s, the countdown
      // will return first, and a time out message is returned.
      return Promise.race(
        [ countdown(30000).then(() => {
            return 'NAT classification timed out.';
          }),
          nat_probe.probe().then((natType:string) => {
            globals.setGlobalNatType(natType);
            // Store NAT type for five minutes. This way, if the user previews
            // their logs, and then submits them shortly after, we do not need
            // to determine the NAT type once for the preview, and once for
            // submission to our backend.
            // If we expect users to check NAT type frequently (e.g. if they
            // switch between networks while troubleshooting), then we might want
            // to remove caching.
            clearTimeout(this.natResetTimeout_);
            this.natResetTimeout_ = setTimeout(() => {globals.setGlobalNatType('');}, 300000);
            return globals.natType;
          })
        ]);
    } else {
      return Promise.resolve(globals.natType);
    }
  }

  public getPortControlSupport = (): Promise<uproxy_core_api.PortControlSupport> => {
    return portControl.probeProtocolSupport().then(
        (probe:freedom.PortControl.ProtocolSupport) => {
          return (probe.natPmp || probe.pcp || probe.upnp) ?
                 uproxy_core_api.PortControlSupport.TRUE :
                 uproxy_core_api.PortControlSupport.FALSE;
    });
  }

  // Probe for NAT-PMP, PCP, and UPnP support
  // Sets this.portControlSupport_ and sends update message to UI
  public refreshPortControlSupport = () :Promise<void> => {
    this.portControlSupport_ = uproxy_core_api.PortControlSupport.PENDING;
    ui.update(uproxy_core_api.Update.PORT_CONTROL_STATUS,
              uproxy_core_api.PortControlSupport.PENDING);

    return this.getPortControlSupport().then((support) => {
      this.portControlSupport_ = support;
      ui.update(uproxy_core_api.Update.PORT_CONTROL_STATUS,
                this.portControlSupport_);
    });
  }

  // Checks to see if socks reproxy server is listening on input port by
  // issuing auth request and checking for successful response.
  public checkReproxy = (port :number) :Promise<uproxy_core_api.ReproxyCheck> => {
    var socksEndpoint = {
      address: '127.0.0.1',
      port: port
    };
    var socksConnection = new tcp.Connection({endpoint: socksEndpoint}, false);
    return socksConnection.onceConnected
      .then((info :tcp.ConnectionInfo) :Promise<ArrayBuffer> => {
        socksConnection.send(socks.composeAuthHandshakeBuffer([socks.Auth.NOAUTH]));
        return socksConnection.receiveNext();
      }).then((buffer :ArrayBuffer) :uproxy_core_api.ReproxyCheck => {
        socks.interpretAuthResponse(buffer);
        return uproxy_core_api.ReproxyCheck.TRUE;
      }).catch((e :Error) :uproxy_core_api.ReproxyCheck => {
        return uproxy_core_api.ReproxyCheck.FALSE;
      }).then((result :uproxy_core_api.ReproxyCheck) :uproxy_core_api.ReproxyCheck => {
        socksConnection.close();
        return result;
      });
  }

  // Probe the NAT type and support for port control protocols
  // Returns an object with the NAT configuration as keys
  public getNetworkInfoObj = () :Promise<uproxy_core_api.NetworkInfo> => {
    var natInfo :uproxy_core_api.NetworkInfo = {
      natType: undefined,
      pmpSupport: undefined,
      pcpSupport: undefined,
      upnpSupport: undefined
    };

    return this.getNatType().then((natType:string) => {
      natInfo.natType = natType;
      return portControl.probeProtocolSupport().then(
        (probe:freedom.PortControl.ProtocolSupport) => {
          natInfo.pmpSupport = probe.natPmp;
          natInfo.pcpSupport = probe.pcp;
          natInfo.upnpSupport = probe.upnp;
          return natInfo;
      }).catch((err:Error) => {
        // Should only catch the error when getInternalIp() times out
        natInfo.errorMsg = 'Could not probe for port control protocols: ' + err.message;
        return natInfo;
      });
    });
  }

  // Returns a string of the NAT type and support for port control protocols
  public getNetworkInfo = () :Promise<string> => {
    return this.getNetworkInfoObj().then((natInfo:uproxy_core_api.NetworkInfo) => {
      var natInfoStr = 'NAT Type: ' + natInfo.natType + '\n';
      if (natInfo.errorMsg) {
        natInfoStr += natInfo.errorMsg + '\n';
      } else {
        natInfoStr += 'NAT-PMP: ' +
                  (natInfo.pmpSupport ? 'Supported' : 'Not supported') + '\n';
        natInfoStr += 'PCP: ' +
                  (natInfo.pcpSupport ? 'Supported' : 'Not supported') + '\n';
        natInfoStr += 'UPnP IGD: ' +
                  (natInfo.upnpSupport ? 'Supported' : 'Not supported') + '\n';
      }
      return natInfoStr;
    });
  }

  public getLogs = () :Promise<string> => {
    return loggingController.getLogs().then((rawLogs:string[]) => {
        var formattedLogsWithVersionInfo =
            'Version: ' + JSON.stringify(version.UPROXY_VERSION) + '\n\n';
        formattedLogsWithVersionInfo += this.formatLogs_(rawLogs);
        return formattedLogsWithVersionInfo;
      });
  }

  public getLogsAndNetworkInfo = () :Promise<string> => {
    return Promise.all([this.getNetworkInfo(),
                        this.getLogs()])
      .then((natAndLogs) => {
        // natAndLogs is an array of returned values corresponding to the
        // array of Promises in Promise.all.
        return natAndLogs[0] + '\n' + natAndLogs[1];
      });
  }

  private formatLogs_ = (logs :string[]) :string => {
    // Searches through text for all JSON fields of the specified key, then
    // replaces the values with the prefix + a counter.
    // e.g.
    //   jsonFieldReplace(
    //       '{"name":"Alice"}...{\\"name\\":\\"Bob\\"}...Alice...Bob...',
    //        'name', 'NAME_');
    // will return:
    //   '{"name":"NAME_1"}...{\\"name\\":\\"NAME_2\\"}...NAME_1...NAME_2...'
    var jsonFieldReplace = (text :string, key :string, prefix :string)
        : string => {
      // Allow for escaped JSON to be matched, e.g. {\"name\":\"Bob\"}
      var re = new RegExp('\\\\*"' + key + '\\\\*":\\\\*"([^"]+)"', 'g');
      var matches :string[];
      var uniqueValueSet :{[value :string] :Boolean} = {};
      while (matches = re.exec(text)) {
        matches[1].replace(/\\+$/, '');  // Removing trailing \
        uniqueValueSet[matches[1]] = true;  // Add userId, name, etc to set.
      }
      var index = 1;
      for (var value in uniqueValueSet) {
        // Replace all occurances of value in text.
        var escapedRegex = new RegExp(
            // Escape all special regex characters, from
            // http://stackoverflow.com/questions/3446170/
            value.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&'),
            'g');
        text = text.replace(escapedRegex, prefix + index);
        ++index;
      }
      return text;
    }

    var text = logs.join('\n');

    text = jsonFieldReplace(text, 'name', 'NAME_');
    text = jsonFieldReplace(text, 'userId', 'USER_ID_');
    text = jsonFieldReplace(text, 'imageData', 'IMAGE_DATA_');
    text = jsonFieldReplace(text, 'url', 'URL_');

    // Replace any emails that may have been missed when replacing userIds.
    // Email regex taken from regular-expressions.info
    text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,4}\b/ig,
                        'EMAIL_ADDRESS');
    return text;
  }

  public pingUntilOnline = (pingUrl :string) : Promise<void> => {
    var ping = () : Promise<void> => {
      return new Promise<void>(function(fulfill, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', pingUrl);
        xhr.onload = function() { fulfill(); };
        xhr.onerror = function(e) { reject(new Error('Ping failed')); };
        xhr.send();
      });
    }

    return new Promise<void>((fulfill, reject) => {
      var checkIfOnline = () => {
        ping().then(() => {
          clearInterval(intervalId);
          fulfill();
        }).catch((e) => {
          // Ping failed (may be because the internet is disconnected),
          // we will try again on the next interval.
        });
      };
      var intervalId = setInterval(checkIfOnline, 5000);
      checkIfOnline();
    });
  }

  public getVersion = () :Promise<{ version :string }> => {
    return Promise.resolve(version.UPROXY_VERSION);
  }

  public handleUpdate = (details :{version :string}) => {
    this.availableVersion_ = details.version;
    ui.update(uproxy_core_api.Update.CORE_UPDATE_AVAILABLE, details);
  }

  public cloudUpdate = (args: uproxy_core_api.CloudOperationArgs)
      :Promise<uproxy_core_api.CloudOperationResult> => {
    if (args.providerName !== CLOUD_PROVIDER_NAME) {
      return Promise.reject(new Error('unsupported cloud provider'));
    }

    let newCloudOpResult = () :uproxy_core_api.CloudOperationResult => ({});

    switch (args.operation) {
      case uproxy_core_api.CloudOperationType.CLOUD_INSTALL:
        if (!args.region) {
          return Promise.reject(new Error('no region specified for cloud provider'));
        }
        return this.createCloudServer_(args.region).then(newCloudOpResult);
      case uproxy_core_api.CloudOperationType.CLOUD_DESTROY:
        return this.destroyCloudServer_().then(newCloudOpResult);
      case uproxy_core_api.CloudOperationType.CLOUD_REBOOT:
        return this.rebootCloudServer_().then(newCloudOpResult);
      case uproxy_core_api.CloudOperationType.CLOUD_HAS_OAUTH:
        return this.cloudHasOAuth().then(
          (hasOAuth :boolean) :uproxy_core_api.CloudOperationResult => {
            return {hasOAuth: hasOAuth};
          }
        );
      default:
        return Promise.reject(new Error('cloud operation not supported'));
    }
  }

  public cloudHasOAuth = () :Promise<boolean> => {
    return oneShotModule_(CLOUD_PROVIDER_MODULE_NAME,
                          (provider :any) => provider.hasOAuth());
  }

  private createCloudServer_ = (region: string) => {
    log.debug('creating cloud server in %1', region);

    // Since this step can take a while, start >0 so there's less confusion
    // that this is a progress bar.
    ui.update(uproxy_core_api.Update.CLOUD_INSTALL_STATUS, 'CLOUD_INSTALL_STATUS_CREATING_SERVER');
    ui.update(uproxy_core_api.Update.CLOUD_INSTALL_PROGRESS, CLOUD_DEPLOY_PROGRESS / 2);

    return this.loginIfNeeded_('Cloud').then((cloudNetwork) => {
      return oneShotModule_(CLOUD_PROVIDER_MODULE_NAME, (provider: any) => {
        return provider.start(CLOUD_DROPLET_NAME, region);
      }).catch((e: any) => {
        if (e.errcode === 'VM_AE') {
          // This string has special meaning for the polymer template.
          return Promise.reject(new Error('server already exists'));
        } else {
          return Promise.reject(e);
        }
      }).then((serverInfo: any) => {
        const host = serverInfo.network.ipv4;
        const port = serverInfo.network.ssh_port;

        log.debug('installing cloud on new droplet at %1:%2 (server details: %3)', host, port, serverInfo);

        ui.update(uproxy_core_api.Update.CLOUD_INSTALL_PROGRESS, CLOUD_DEPLOY_PROGRESS);
        ui.update(uproxy_core_api.Update.CLOUD_INSTALL_STATUS, 'CLOUD_INSTALL_STATUS_LOGGING_IN');

        return oneShotModule_(CLOUD_INSTALLER_MODULE_NAME, (installer: any) => {
          installer.on('status', (status: number) => {
            ui.update(uproxy_core_api.Update.CLOUD_INSTALL_STATUS, status);
          });

          installer.on('progress', (progress: number) => {
            ui.update(uproxy_core_api.Update.CLOUD_INSTALL_PROGRESS,
              CLOUD_DEPLOY_PROGRESS + (progress * ((100 - CLOUD_DEPLOY_PROGRESS) / 100)));
          });

          return installer.install(host, port, 'root', serverInfo.ssh.private);
        }).then((cloudNetworkData: any) => {
          // Set flag so Cloud social provider knows this invite is for the admin
          // user, who just created the server.
          cloudNetworkData['isAdmin'] = true;

          // We cast to any because InviteTokenData currently has a required userName
          // field which is unused by the cloud social provider.
          // TODO: what if this fails?
          return cloudNetwork.acceptInvitation(<any>{
            v: 2,
            networkName: 'Cloud',
            networkData: JSON.stringify(cloudNetworkData)
          });
        });
      });
    });
  }

  private destroyCloudServer_ = () => {
    log.debug('destroying cloud server');
    return oneShotModule_<void>(CLOUD_PROVIDER_MODULE_NAME, (provider: any) => {
      return provider.stop(CLOUD_DROPLET_NAME);
    });
  }

  private rebootCloudServer_ = () => {
    log.debug('rebooting cloud server');
    return oneShotModule_<void>(CLOUD_PROVIDER_MODULE_NAME, (provider: any) => {
      return provider.reboot(CLOUD_DROPLET_NAME);
    });
  }

  // Gets a social.Network, and logs the user in if they aren't yet logged in.
  private loginIfNeeded_ = (networkName :string) : Promise<social.Network> => {
    let network = this.getNetworkByName_(networkName);
    if (network) {
      return Promise.resolve(network);
    }

    // User is not yet logged in.
    return this.login({
      network: networkName,
      loginType: uproxy_core_api.LoginType.INITIAL
    }).then(() => {
      return this.getNetworkByName_(networkName);
    });
  }

  // The social_network module in theory should support multiple userIds
  // being logged into the same network.  However that has never been tested
  // and is not used by the rest of uProxy code.  This method just returns
  // the first (and currently only) network for the given networkName, or null
  // if the network is not logged in.
  private getNetworkByName_ = (networkName :string) : social.Network => {
    for (var userId in social_network.networks[networkName]) {
      return social_network.networks[networkName][userId];
    }
    return null;
  }

  public updateOrgPolicy = (policy :uproxy_core_api.ManagedPolicyUpdate): void => {
    // have to load settings first to make sure we don't overwrite anything
    globals.loadSettings.then(() => {
      globals.settings.enforceProxyServerValidity =
          policy.enforceProxyServerValidity;
      globals.settings.validProxyServers = policy.validProxyServers;
      this.updateGlobalSettings(globals.settings);

      ui.update(uproxy_core_api.Update.REFRESH_GLOBAL_SETTINGS, globals.settings);
    });
  }

  public verifyUser = (inst:social.InstancePath) :void => {
    log.info('app.core: verifyUser:', inst);
    // There are additional things our social_network system supports
    // beyond what the freedom social api supports.  So we have to
    // cast into our local API's types to get access to RemoteInstance
    // (which implements no related interfaces).
    var network = <social_network.AbstractNetwork>this.getNetworkByName_(
      inst.network.name);
    var remoteUser :remote_user.User = network.getUser(inst.userId);
    var remoteInstance :remote_instance.RemoteInstance =
      remoteUser.getInstance(inst.instanceId);
    remoteInstance.verifyUser();
  }

  public finishVerifyUser = (args:uproxy_core_api.FinishVerifyArgs) :void => {
    let inst = args.inst;
    log.info('app.core: finishVerifyUser:', inst, ' with result ', args.sameSAS);
    var network = <social_network.AbstractNetwork>this.getNetworkByName_(
      inst.network.name);
    var remoteUser :remote_user.User = network.getUser(inst.userId);
    var remoteInstance :remote_instance.RemoteInstance =
      remoteUser.getInstance(inst.instanceId);
    remoteInstance.finishVerifyUser(args.sameSAS);
  }

  // Remove contact from friend list and storage
  public removeContact = (args :uproxy_core_api.RemoveContactArgs) : Promise<void> => {
    log.info('removeContact', args);
    const network = this.getNetworkByName_(args.networkName);
    return network.removeUserFromStorage(args.userId).then(() => {
      return ui.removeFriend({
        networkName: args.networkName,
        userId: args.userId
      });
    }).then(() => {
      // If we removed the only cloud friend, logout of the cloud network
      if (args.networkName === 'Cloud') {
        return this.logoutIfRosterEmpty_(network);
      }
    });
  }

  private logoutIfRosterEmpty_ = (network :social.Network) : Promise<void> => {
    if (Object.keys(network.roster).length === 0) {
      return this.logout({
       name: network.name
      }).then(() => {
        log.info('Successfully logged out of %1 network because roster is empty', network.name);
      });
    }
    return Promise.resolve();
  }
}  // class uProxyCore
