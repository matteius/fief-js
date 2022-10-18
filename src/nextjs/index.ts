import { IncomingMessage, OutgoingMessage } from 'http';
import type {
  GetServerSideProps,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
  PreviewData,
  NextApiHandler,
  NextApiRequest,
  NextApiResponse,
} from 'next';
import { NextRequest, NextResponse } from 'next/server';
import type { ParsedUrlQuery } from 'querystring';
import { pathToRegexp } from 'path-to-regexp';

import { Fief, FiefAccessTokenInfo, FiefUserInfo } from '../client';
import {
  AuthenticateRequestParameters,
  AuthenticateRequestResult,
  FiefAuth as FiefAuthServer,
  FiefAuthForbidden,
  FiefAuthUnauthorized,
  IUserInfoCache,
  TokenGetter,
  authorizationBearerGetter,
  cookieGetter,
} from '../server';

const getServerSidePropsResultIsProps = <P>(result: GetServerSidePropsResult<P>): result is { props: P | Promise<P> } => Object.prototype.hasOwnProperty.call(result, 'props');

const defaultUnauthorizedResponse = async (req: NextApiRequest, res: NextApiResponse) => {
  res.status(401).send('Unauthorized');
};

const defaultForbiddenResponse = async (req: NextApiRequest, res: NextApiResponse) => {
  res.status(403).send('Forbidden');
};

type FiefNextApiHandler<T> = (
  req: NextApiRequest & AuthenticateRequestResult,
  res: NextApiResponse<T>,
) => unknown | Promise<unknown>;

interface FiefAuthParameters {
  client: Fief;
  sessionCookieName: string;
  redirectURI: string;
  redirectPath?: string;
  logoutRedirectURI: string;
  logoutPath?: string;
  returnToCookieName?: string;
  returnToDefault?: string;
  forbiddenPath?: string;
  userInfoCache?: IUserInfoCache;
  unauthorizedResponse?: (req: IncomingMessage, res: OutgoingMessage) => Promise<void>;
  forbiddenResponse?: (req: IncomingMessage, res: OutgoingMessage) => Promise<void>;
}

type PathsConfig = { matcher: string, parameters: AuthenticateRequestParameters }[];

class FiefAuth {
  private client: Fief;

  private fiefAuth: FiefAuthServer<IncomingMessage>;

  private fiefAuthEdge: FiefAuthServer<NextRequest>;

  private userInfoCache?: IUserInfoCache;

  private sessionCookieName: string;

  private redirectURI: string;

  private redirectPath: string;

  private logoutRedirectURI: string;

  private logoutPath: string;

  private returnToCookieName: string;

  private returnToDefault: string;

  private forbiddenPath: string;

  private unauthorizedResponse: (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

  private forbiddenResponse: (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

  constructor(parameters: FiefAuthParameters) {
    this.client = parameters.client;

    this.fiefAuth = new FiefAuthServer(
      parameters.client,
      cookieGetter(parameters.sessionCookieName),
      parameters.userInfoCache,
    );
    this.fiefAuthEdge = new FiefAuthServer(
      parameters.client,
      async (request) => request.cookies.get(parameters.sessionCookieName) || null,
      parameters.userInfoCache,
    );

    this.userInfoCache = parameters.userInfoCache;

    this.sessionCookieName = parameters.sessionCookieName;

    this.redirectURI = parameters.redirectURI;
    this.redirectPath = parameters.redirectPath ? parameters.redirectPath : '/callback';

    this.logoutRedirectURI = parameters.logoutRedirectURI;
    this.logoutPath = parameters.logoutPath ? parameters.logoutPath : '/logout';

    this.returnToCookieName = parameters.returnToCookieName ? parameters.returnToCookieName : 'return_to';
    this.returnToDefault = parameters.returnToDefault ? parameters.returnToDefault : '/';

    this.forbiddenPath = parameters.forbiddenPath ? parameters.forbiddenPath : '/forbidden';

    this.unauthorizedResponse = parameters.unauthorizedResponse
      ? parameters.unauthorizedResponse
      : defaultUnauthorizedResponse
    ;
    this.forbiddenResponse = parameters.forbiddenResponse
      ? parameters.forbiddenResponse
      : defaultForbiddenResponse
    ;
  }

  public middleware(pathsConfig: PathsConfig) {
    const compiledPathsAuthenticators = pathsConfig.map(({ matcher, parameters }) => ({
      matcher: pathToRegexp(matcher),
      authenticate: this.fiefAuthEdge.authenticate(parameters),
    }));
    return async (request: NextRequest): Promise<NextResponse> => {
      // Handle authentication callback
      if (request.nextUrl.pathname === this.redirectPath) {
        const code = request.nextUrl.searchParams.get('code');
        const [tokens, userinfo] = await this.client.authCallback(code as string, this.redirectURI);

        const returnTo = request.cookies.get(this.returnToCookieName);
        const redirectURL = new URL(returnTo || this.returnToDefault, request.url);
        const response = NextResponse.redirect(redirectURL);
        response.cookies.set(
          this.sessionCookieName,
          tokens.access_token,
          {
            maxAge: tokens.expires_in,
            httpOnly: true,
            secure: false,
          },
        );
        response.cookies.set(this.returnToCookieName, '', { maxAge: 0 });

        if (this.userInfoCache) {
          this.userInfoCache.set(userinfo.sub, userinfo);
        }

        return response;
      }

      // Handle logout
      if (request.nextUrl.pathname === this.logoutPath) {
        const logoutURL = await this.client.getLogoutURL({ redirectURI: this.logoutRedirectURI });
        const response = NextResponse.redirect(logoutURL);
        response.cookies.set(this.sessionCookieName, '', { maxAge: 0 });
        return response;
      }

      // Check authentication for configured paths
      for (let i = 0; i < compiledPathsAuthenticators.length; i += 1) {
        const { matcher, authenticate } = compiledPathsAuthenticators[i];
        if (matcher.exec(request.nextUrl.pathname)) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await authenticate(request);
          } catch (err) {
            if (err instanceof FiefAuthUnauthorized) {
              // eslint-disable-next-line no-await-in-loop
              const authURL = await this.client.getAuthURL({ redirectURI: this.redirectURI, scope: ['openid'] });

              const response = NextResponse.redirect(authURL);
              response.cookies.set(this.returnToCookieName, request.nextUrl.pathname);

              return response;
            }
            if (err instanceof FiefAuthForbidden) {
              return NextResponse.rewrite(new URL(this.forbiddenPath, request.url));
            }
          }
        }
      }

      // Default response
      return NextResponse.next();
    };
  }

  public withAuth<
    P extends { [key: string]: any } = { [key: string]: any },
    Q extends ParsedUrlQuery = ParsedUrlQuery,
    D extends PreviewData = PreviewData,
  >(
    getServerSideProps: GetServerSideProps<P, Q, D>,
    authenticatedParameters: AuthenticateRequestParameters = {},
  ) {
    const authenticate = this.fiefAuth.authenticate(authenticatedParameters);
    return async (
      context: GetServerSidePropsContext<Q, D>,
      // eslint-disable-next-line max-len
    ): Promise<GetServerSidePropsResult<P & AuthenticateRequestResult & { forbidden: boolean }>> => {
      const { req, res, resolvedUrl } = context;
      let user: FiefUserInfo | null = null;
      let accessTokenInfo: FiefAccessTokenInfo | null = null;
      let forbidden = false;
      try {
        const result = await authenticate(req);
        user = result.user;
        accessTokenInfo = result.accessTokenInfo;
      } catch (err) {
        if (err instanceof FiefAuthUnauthorized) {
          const authURL = await this.client.getAuthURL({ redirectURI: this.redirectURI, scope: ['openid'] });

          res.setHeader('Set-Cookie', `${this.returnToCookieName}=${resolvedUrl}`);

          return {
            redirect: {
              destination: authURL,
              permanent: false,
            },
          };
        }
        if (err instanceof FiefAuthForbidden) {
          forbidden = true;
        }
      }

      const result = await getServerSideProps(context);
      if (getServerSidePropsResultIsProps(result)) {
        if (result.props instanceof Promise) {
          return {
            ...result,
            props: {
              ...(await result.props),
              accessTokenInfo,
              user,
              forbidden,
            },
          };
        }
        return {
          ...result,
          props: {
            ...result.props,
            accessTokenInfo,
            user,
            forbidden,
          },
        };
      }

      return result;
    };
  }

  public authenticated<T>(
    route: NextApiHandler<T>,
    authenticatedParameters: AuthenticateRequestParameters = {},
  ): FiefNextApiHandler<T> {
    const authenticate = this.fiefAuth.authenticate(authenticatedParameters);
    return async (req: NextApiRequest & AuthenticateRequestResult, res: NextApiResponse) => {
      let user: FiefUserInfo | null = null;
      let accessTokenInfo: FiefAccessTokenInfo | null = null;
      try {
        const result = await authenticate(req);
        user = result.user;
        accessTokenInfo = result.accessTokenInfo;
      } catch (err) {
        if (err instanceof FiefAuthUnauthorized) {
          return this.unauthorizedResponse(req, res);
        }
        if (err instanceof FiefAuthForbidden) {
          return this.forbiddenResponse(req, res);
        }
      }

      req.accessTokenInfo = accessTokenInfo;
      req.user = user;
      return route(req, res);
    };
  }
}

export {
  AuthenticateRequestParameters,
  IUserInfoCache,
  TokenGetter,
  authorizationBearerGetter,
  cookieGetter,
  FiefAuth,
};
