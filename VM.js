var Reflect = require('harmony-reflect');
var recast = require("recast");
var Scope = require('./Scope');
var Compiler = require('./Compiler');
var Interpreter = require('./Interpreter');
var PromiseInterceptor = require('./PromiseInterceptor');

/**
 *
 * @param global
 * @param name
 * @constructor
 */
function VM(global, name) {
  this.setGlobal(global);
  this.functionData = new WeakMap();
  this.stack = [];
  this.name = name || "VM" + Math.round(Math.random() * 100000);
  // Creating default execution context, as a new closure (in global context), and access to evaluate within it;
  this.sandbox = new Function("global", "capture", "link", "close", "undefined",
                              "return function globalEval() {         " +
                              "   return eval(arguments[0]);" +
                              "}");
  // Retrieving evaluation function within the sandbox environment
  var evaluate = this.sandbox.call(this.global, this.global, capture.bind(this), link.bind(this), close.bind(this));
  // Creating new scope for the sandbox environment, with the right variables
  this.scope = new Scope(this.sandbox, evaluate, this.global, this.global);
  this.compiler = new Compiler();
  this.interpreter = new Interpreter(this);
}
/**
 * Sets global object, and populates with required objects
 * @param global
 */
VM.prototype.setGlobal = function (global) {
  this.global = Object.create(global);
  var self = this;
  // Intercepting calls to eval
  this.global.eval = function eval(code) {
    var callingFunction = eval.caller;
    var parentScope = self.scope.getParentScope(callingFunction);
    return parentScope.eval(code);
  }

  this.global.getAst = function (functionObject) {
    return self.functionData.get(functionObject);
  }

  this.global.getOriginal = function (functionObject) {
    var ast = self.functionData.get(functionObject);
    return self.compiler.getFunctionSourceCode(ast.block.original);
  }
  this.global.setEnvironment = function (functionObject, environment) {
    var parentScope = self.scope.getParentScope(functionObject);
    parentScope.setEnvironment(environment);
  }
  this.global.getEnvironment = function (functionObject) {
    var parentScope = self.scope.getParentScope(functionObject);
    return parentScope.getEnvironment();
  }
  this.global.getEnvironmentVariable = function (functionObject, name) {
    var parentScope = self.scope.getParentScope(functionObject);
    return parentScope.get(name);
  }
  this.global.evalInScope = function (functionObject, code) {
    var parentScope = self.scope.getParentScope(functionObject);
    return parentScope.eval(code);
  }
  this.global.clearEnvironment = function () {
    self.setGlobal({});
  };
  this.global.setTimeout = setTimeout;
  this.global.Math = Math;
  this.global.Promise = PromiseInterceptor;
};

VM.prototype.getScope = function (functionObject) {
  return this.scope.getParentScope(functionObject);
};

VM.prototype.getFunctionAst = function (functionObject) {
  var data = this.functionData.get(functionObject);
  return data.ast;
};
VM.prototype.getAstFunction = function (ast) {
  var func = this.functionData.get(ast);
  if ( !func ) {
    return this.scope.evaluate;
  }
  else {
    return func;
  }
};

/**
 * Evaluates code within the context of the VM
 * @param code
 * @returns {*}
 */
VM.prototype.eval = function vmEval(code) {
  var self = this;
  return PromiseInterceptor.unWrap(function interceptorEvaluate() {
    var result, error;
    // pushing the sandbox as the first caller on the stack (important for link);
    self.stack.push({ caller: self.scope.evaluate, scope: self.scope, linkCounter: 0 });
    try {
      var compiledCode = self.compiler.compile(code);
      self.code = compiledCode;
      result = self.scope.eval("//# sourceURL=" + self.name + "\n'use strict';\n" + compiledCode);
    } catch ( err ) {
      error = err;
    }
    self.stack.pop();
    if ( error ) {
      throw(error);
    }
    else {
      return result;
    }
  }, function vmIntercept(interceptedPromise, executionStackPoints) {
    // Stopping execution
    var promiseToInterpret = self.interpret(interceptedPromise, executionStackPoints);
    // returning the promise to finish execution
    return promiseToInterpret;
  });

};

VM.prototype.interpret = function (interceptedPromise, executionStackPoints) {
  var self = this;
  console.log("This is a special promise error", executionStackPoints, this.stack);
  var promiseToInterpret = new Promise(function (succeed, reject) {
    // Some how continue evaluation
    promise.then(function (result) {
      self.interpreter.continue(executionStackPoints);

      succeed("We are evaluating in interpreter mode! " + result);
    }).catch(function (error) {
      reject(error);
    });
  });
  return promiseToInterpret;
};

VM.prototype.resume = function () {

};

VM.prototype.pause = function () {

};

VM.prototype.save = function () {

};

VM.prototype.load = function () {

};

/**
 * Adds a caller to the stack
 * @param func
 * @param scope
 */
VM.prototype.pushCaller = function (func, scope) {
  this.stack.push(
    {
      caller     : func,
      scope      : scope,
      linkCounter: 0
    }
  );
};
/**
 * Removes the last stack frame from the caller stack
 * @param func
 * @param scope
 * @returns {T}
 */
VM.prototype.popCaller = function () {
  var stackFrame = this.stack.pop();
  return stackFrame;
};

/**
 * Try catch helper function,
 * Attempts to detect if the error is a VM handled error (such as interceptor errors), or an error that needs to
 * bubble up.
 * It also removes any references in the error stack, to out-of-vm information
 * @param tryCallback
 * @param catchCallback
 */
VM.prototype.tryCatch = function (tryCallback, catchCallback) {
  try {
    tryCallback();
  } catch ( error ) {
    catchCallback(error)
  }
};

/**
 * Private Capture function to be made available within the sandbox environment
 * @param parentFunction
 * @param evaluate
 * @param environment
 * @param thisVar
 */
function capture(parentFunction, evaluate, environment, thisVar) {
  var scope = this.scope.create(parentFunction, evaluate, environment, thisVar);
  scope.data = this.functionData.get(parentFunction);
  this.pushCaller(parentFunction, scope);
}

/**
 * Private Link function to be available within the sandbox environment
 * @param closure
 * @returns {*|*|null|string|{value}}
 */
function link(closure) {
  var stackFrame = this.stack[this.stack.length - 1]; // Current stack frame is always the last on the stack
  // Getting current scope
  var scope = stackFrame.scope;
  // retrieving scope data
  var scopeData = ( scope === this.scope ) ? this.compiler.scope.data : scope.data;
  // storing scope data on weak map, associating it with the function
  this.functionData.set(closure, scopeData.children[stackFrame.linkCounter]);
  // storing ast node to closure association for later serialization
  var node = scopeData.children[stackFrame.linkCounter++].node;
  this.functionData.set(node, closure);
  // Linking and returning function
  return scope.link(closure);
}

/**
 * Private close function to be available within the sandbox environment
 * @param closure
 * @returns {*|*|null|string|{value}}
 */
function close(returnValue) {
  this.popCaller();

  // If there is a need to save the scope (because of partial execution, closure creation, etc)
  //stackFrame.scope.save();
  return returnValue;
}

module.exports = VM;
