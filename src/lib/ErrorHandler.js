import { log } from '../lib/Logger';
import { COMMUNICATION_LINKS_FAILURE, UNAUTHORIZED, INTERNAL_SERVER_ERROR, FORBIDDEN, BAD_REQUEST, INVALID_TOKEN, UNPROCESSABLE_ENTITY } from '../lib/HttpStatuses';
import UnauthorizedError from '../errors/UnauthorizedError';
import AppNotEnabledError from '../errors/AppNotEnabledError';
import InsufficientPermissionsError from '../errors/InsufficientPermissionsError';
import SessionNotFound from '../errors/SessionNotFound';
import MissingHeaderError from '../errors/MissingHeaderError';
import InvalidTokenError from '../errors/InvalidTokenError';
import TokenExpiredError from '../errors/TokenExpiredError';
import JsonWebTokenError from '../errors/JsonWebTokenError';
import UnableToUpdateError from '../errors/UnableToUpdateError';
import { serverSideLogout } from '../lib/Session';

export async function defaultErrorHandler(error, req, res) {
  
  await log(error.stack);
  
  if (
    error instanceof UnauthorizedError ||
    error instanceof SessionNotFound
    ) {
      res.status(UNAUTHORIZED).json({message: 'Authentication required.'});
  } else if (
    error instanceof AppNotEnabledError || 
    error instanceof InsufficientPermissionsError
  ) {
      res.status(FORBIDDEN).json({message: 'Forbidden.'});
  } else if (
    error instanceof MissingHeaderError
  ) {
      res.status(BAD_REQUEST).json({message: 'Bearer token is missing.'});
  } else if (
    error instanceof InvalidTokenError ||
    error instanceof JsonWebTokenError
  ) {
      res.status(INVALID_TOKEN).json({ message: 'Invalid or expired token.' });
  } else if (
    error instanceof TokenExpiredError
  ) {
      console.log('I AM HERE 1')
      await serverSideLogout(req);
      console.log('I AM HERE 2')
      res.status(INVALID_TOKEN).json({ message: 'Token expired. Please log in again.' });
  } else if (
    error instanceof UnableToUpdateError
  ) {
      res.status(UNPROCESSABLE_ENTITY).json({ message: error.message ?? 'Unable to update values.' });
  } else {
      /* Let's be conservative on our regex*/
      if (error.stack.match(/Communications\s+link\s+failure/gi)) {
        //Let the client side retry.
        res.status(COMMUNICATION_LINKS_FAILURE).json({message: 'The database may be warming up. Please try again.'});
      } else {
        //Do not reveal anything to the user. This might be an opportunity for intruders
        //to get into the system.
        res.status(INTERNAL_SERVER_ERROR).json({message: 'Internal server error. Check the logs for details.'});
      }
  }
} 

